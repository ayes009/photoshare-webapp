from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from azure.storage.blob import BlobServiceClient, ContentSettings
import json
import base64
import os
from datetime import datetime
import io

app = Flask(__name__, static_folder='static')
CORS(app)

# Azure Blob Storage Configuration
STORAGE_ACCOUNT = "photoshare123"
CONTAINER_NAME = "photos"
METADATA_CONTAINER = "metadata"
SAS_TOKEN = "sv=2024-11-04&ss=b&srt=co&sp=rwdctfx&se=2026-01-07T04:01:36Z&st=2026-01-06T19:46:36Z&spr=https&sig=JzbWbKVLzdBwWMmaZ6KeG2qRLRJui%2Ft8U1On3VPbqKU%3D"
BLOB_SERVICE_URL = f"https://{STORAGE_ACCOUNT}.blob.core.windows.net"

# Initialize Blob Service Client
connection_string = f"{BLOB_SERVICE_URL}?{SAS_TOKEN}"
blob_service_client = BlobServiceClient(account_url=BLOB_SERVICE_URL, credential=SAS_TOKEN)

# Serve frontend
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('static', path)

# ============================================
# API Routes
# ============================================

@app.route('/api/auth/login', methods=['POST', 'OPTIONS'])
def login():
    """Handle user login - Open access, no authentication required"""
    if request.method == 'OPTIONS':
        return '', 204
    
    try:
        data = request.get_json()
        username = data.get('username', 'Guest')
        role = data.get('role', 'consumer')
        
        # Validate role
        if role not in ['creator', 'consumer']:
            return jsonify({'error': 'Role must be either creator or consumer'}), 400
        
        # Create user session (no password validation for open access)
        user = {
            'id': str(int(datetime.now().timestamp() * 1000)),
            'username': username,
            'role': role,
            'token': base64.b64encode(f"{username}:{datetime.now().timestamp()}".encode()).decode()
        }
        
        app.logger.info(f"User {username} logged in as {role} (guest access)")
        
        return jsonify({
            'user': user,
            'message': 'Access granted - Welcome to PhotoShare!'
        }), 200
        
    except Exception as e:
        app.logger.error(f"Login error: {str(e)}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/photos', methods=['GET', 'OPTIONS'])
def get_photos():
    """Get all photos from Azure Blob Storage"""
    if request.method == 'OPTIONS':
        return '', 204
    
    try:
        photos = []
        metadata_container_client = blob_service_client.get_container_client(METADATA_CONTAINER)
        
        try:
            # List all metadata blobs
            blob_list = metadata_container_client.list_blobs()
            
            for blob in blob_list:
                if blob.name.endswith('.json'):
                    try:
                        blob_client = metadata_container_client.get_blob_client(blob.name)
                        blob_data = blob_client.download_blob().readall()
                        photo_data = json.loads(blob_data.decode('utf-8'))
                        photos.append(photo_data)
                    except Exception as blob_error:
                        app.logger.error(f"Error reading blob {blob.name}: {str(blob_error)}")
                        
        except Exception as list_error:
            app.logger.warning(f"No photos found or container does not exist: {str(list_error)}")
        
        # Sort by upload date (newest first)
        photos.sort(key=lambda x: x.get('uploadedAt', ''), reverse=True)
        
        app.logger.info(f"Retrieved {len(photos)} photos")
        return jsonify(photos), 200
        
    except Exception as e:
        app.logger.error(f"Error fetching photos: {str(e)}")
        return jsonify({'error': 'Failed to fetch photos', 'details': str(e), 'photos': []}), 500


@app.route('/api/photos', methods=['POST'])
def upload_photo():
    """Upload a new photo to Azure Blob Storage"""
    try:
        data = request.get_json()
        
        title = data.get('title')
        caption = data.get('caption', '')
        location = data.get('location', '')
        tags = data.get('tags', '')
        image_data = data.get('imageData')
        file_name = data.get('fileName')
        
        # Validate required fields
        if not title or not image_data or not file_name:
            return jsonify({'error': 'Title, imageData, and fileName are required'}), 400
        
        # Extract username from auth header
        auth_header = request.headers.get('Authorization', '')
        username = 'Anonymous'
        if auth_header:
            try:
                decoded_token = base64.b64decode(auth_header.replace('Bearer ', '')).decode()
                username = decoded_token.split(':')[0]
            except Exception:
                app.logger.warning('Could not decode auth header')
        
        photo_id = str(int(datetime.now().timestamp() * 1000))
        blob_name = f"{photo_id}-{file_name.replace(' ', '_')}"
        
        # Upload image to photos container
        photo_container_client = blob_service_client.get_container_client(CONTAINER_NAME)
        blob_client = photo_container_client.get_blob_client(blob_name)
        
        # Convert base64 to bytes
        if ',' in image_data:
            base64_data = image_data.split(',')[1]
        else:
            base64_data = image_data
        
        image_bytes = base64.b64decode(base64_data)
        
        # Determine content type
        content_type = 'image/jpeg'
        if file_name.lower().endswith('.png'):
            content_type = 'image/png'
        elif file_name.lower().endswith('.gif'):
            content_type = 'image/gif'
        elif file_name.lower().endswith('.webp'):
            content_type = 'image/webp'
        
        # Upload the image
        blob_client.upload_blob(
            image_bytes,
            content_settings=ContentSettings(content_type=content_type),
            overwrite=True
        )
        
        image_url = f"{BLOB_SERVICE_URL}/{CONTAINER_NAME}/{blob_name}?{SAS_TOKEN}"
        
        # Create photo metadata
        photo = {
            'id': photo_id,
            'title': title,
            'caption': caption,
            'location': location,
            'tags': tags,
            'url': image_url,
            'creatorName': username,
            'likes': 0,
            'comments': [],
            'rating': 0,
            'ratingCount': 0,
            'uploadedAt': datetime.now().isoformat()
        }
        
        # Save metadata to metadata container
        metadata_container_client = blob_service_client.get_container_client(METADATA_CONTAINER)
        metadata_blob_client = metadata_container_client.get_blob_client(f"{photo_id}.json")
        
        metadata_json = json.dumps(photo)
        metadata_blob_client.upload_blob(
            metadata_json.encode('utf-8'),
            content_settings=ContentSettings(content_type='application/json'),
            overwrite=True
        )
        
        app.logger.info(f"Photo uploaded successfully: {photo_id}")
        return jsonify(photo), 201
        
    except Exception as e:
        app.logger.error(f"Error uploading photo: {str(e)}")
        return jsonify({'error': 'Failed to upload photo', 'details': str(e)}), 500


@app.route('/api/photos/<photo_id>', methods=['DELETE', 'OPTIONS'])
def delete_photo(photo_id):
    """Delete a photo from Azure Blob Storage"""
    if request.method == 'OPTIONS':
        return '', 204
    
    try:
        if not photo_id:
            return jsonify({'error': 'Photo ID is required'}), 400
        
        # Get metadata to find blob name
        metadata_container_client = blob_service_client.get_container_client(METADATA_CONTAINER)
        metadata_blob_client = metadata_container_client.get_blob_client(f"{photo_id}.json")
        
        # Check if photo exists
        if not metadata_blob_client.exists():
            return jsonify({'error': 'Photo not found'}), 404
        
        # Get photo metadata
        blob_data = metadata_blob_client.download_blob().readall()
        photo = json.loads(blob_data.decode('utf-8'))
        
        # Extract blob name from URL
        url_parts = photo['url'].split('/')
        blob_name_with_params = url_parts[-1]
        blob_name = blob_name_with_params.split('?')[0]
        
        # Delete the image blob
        photo_container_client = blob_service_client.get_container_client(CONTAINER_NAME)
        image_blob_client = photo_container_client.get_blob_client(blob_name)
        
        try:
            image_blob_client.delete_blob()
        except Exception as delete_error:
            app.logger.warning(f"Image blob deletion failed: {str(delete_error)}")
        
        # Delete metadata
        metadata_blob_client.delete_blob()
        
        app.logger.info(f"Photo deleted successfully: {photo_id}")
        return jsonify({'message': 'Photo deleted successfully', 'photoId': photo_id}), 200
        
    except Exception as e:
        app.logger.error(f"Error deleting photo: {str(e)}")
        return jsonify({'error': 'Failed to delete photo', 'details': str(e)}), 500


@app.route('/api/photos/<photo_id>/like', methods=['POST', 'OPTIONS'])
def like_photo(photo_id):
    """Like a photo"""
    if request.method == 'OPTIONS':
        return '', 204
    
    try:
        if not photo_id:
            return jsonify({'error': 'Photo ID is required'}), 400
        
        metadata_container_client = blob_service_client.get_container_client(METADATA_CONTAINER)
        metadata_blob_client = metadata_container_client.get_blob_client(f"{photo_id}.json")
        
        # Check if photo exists
        if not metadata_blob_client.exists():
            return jsonify({'error': 'Photo not found'}), 404
        
        # Get current metadata
        blob_data = metadata_blob_client.download_blob().readall()
        photo = json.loads(blob_data.decode('utf-8'))
        
        # Increment likes
        photo['likes'] = photo.get('likes', 0) + 1
        
        # Update metadata
        metadata_json = json.dumps(photo)
        metadata_blob_client.upload_blob(
            metadata_json.encode('utf-8'),
            content_settings=ContentSettings(content_type='application/json'),
            overwrite=True
        )
        
        app.logger.info(f"Photo {photo_id} liked. Total likes: {photo['likes']}")
        return jsonify({'success': True, 'likes': photo['likes']}), 200
        
    except Exception as e:
        app.logger.error(f"Error liking photo: {str(e)}")
        return jsonify({'error': 'Failed to like photo', 'details': str(e)}), 500


@app.route('/api/photos/<photo_id>/rate', methods=['POST', 'OPTIONS'])
def rate_photo(photo_id):
    """Rate a photo"""
    if request.method == 'OPTIONS':
        return '', 204
    
    try:
        if not photo_id:
            return jsonify({'error': 'Photo ID is required'}), 400
        
        data = request.get_json()
        rating = data.get('rating')
        
        if not rating or rating < 1 or rating > 5:
            return jsonify({'error': 'Rating must be between 1 and 5'}), 400
        
        metadata_container_client = blob_service_client.get_container_client(METADATA_CONTAINER)
        metadata_blob_client = metadata_container_client.get_blob_client(f"{photo_id}.json")
        
        # Check if photo exists
        if not metadata_blob_client.exists():
            return jsonify({'error': 'Photo not found'}), 404
        
        # Get current metadata
        blob_data = metadata_blob_client.download_blob().readall()
        photo = json.loads(blob_data.decode('utf-8'))
        
        # Calculate new rating
        current_rating = photo.get('rating', 0)
        current_count = photo.get('ratingCount', 0)
        new_rating_count = current_count + 1
        new_rating = ((current_rating * current_count) + rating) / new_rating_count
        
        photo['rating'] = new_rating
        photo['ratingCount'] = new_rating_count
        
        # Update metadata
        metadata_json = json.dumps(photo)
        metadata_blob_client.upload_blob(
            metadata_json.encode('utf-8'),
            content_settings=ContentSettings(content_type='application/json'),
            overwrite=True
        )
        
        app.logger.info(f"Photo {photo_id} rated {rating}. New average: {new_rating:.2f}")
        return jsonify({'success': True, 'rating': new_rating, 'ratingCount': new_rating_count}), 200
        
    except Exception as e:
        app.logger.error(f"Error rating photo: {str(e)}")
        return jsonify({'error': 'Failed to rate photo', 'details': str(e)}), 500


@app.route('/api/photos/<photo_id>/comments', methods=['POST', 'OPTIONS'])
def add_comment(photo_id):
    """Add a comment to a photo"""
    if request.method == 'OPTIONS':
        return '', 204
    
    try:
        if not photo_id:
            return jsonify({'error': 'Photo ID is required'}), 400
        
        data = request.get_json()
        comment_text = data.get('text')
        
        if not comment_text:
            return jsonify({'error': 'Comment text is required'}), 400
        
        # Extract username from auth header
        auth_header = request.headers.get('Authorization', '')
        username = 'Anonymous'
        if auth_header:
            try:
                decoded_token = base64.b64decode(auth_header.replace('Bearer ', '')).decode()
                username = decoded_token.split(':')[0]
            except Exception:
                pass
        
        metadata_container_client = blob_service_client.get_container_client(METADATA_CONTAINER)
        metadata_blob_client = metadata_container_client.get_blob_client(f"{photo_id}.json")
        
        # Check if photo exists
        if not metadata_blob_client.exists():
            return jsonify({'error': 'Photo not found'}), 404
        
        # Get current metadata
        blob_data = metadata_blob_client.download_blob().readall()
        photo = json.loads(blob_data.decode('utf-8'))
        
        # Create new comment
        new_comment = {
            'id': str(int(datetime.now().timestamp() * 1000)),
            'userId': str(int(datetime.now().timestamp())),
            'username': username,
            'text': comment_text,
            'timestamp': datetime.now().isoformat()
        }
        
        # Add comment to photo
        if 'comments' not in photo:
            photo['comments'] = []
        photo['comments'].append(new_comment)
        
        # Update metadata
        metadata_json = json.dumps(photo)
        metadata_blob_client.upload_blob(
            metadata_json.encode('utf-8'),
            content_settings=ContentSettings(content_type='application/json'),
            overwrite=True
        )
        
        app.logger.info(f"Comment added to photo {photo_id}")
        return jsonify(new_comment), 201
        
    except Exception as e:
        app.logger.error(f"Error adding comment: {str(e)}")
        return jsonify({'error': 'Failed to add comment', 'details': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=8000)
