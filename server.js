// ============================================
// FILE: server.js (Main Backend Server)
// ============================================
const express = require('express');
const cors = require('cors');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
const PORT = process.env.PORT || 8080;

// Azure Blob Storage Configuration
const STORAGE_ACCOUNT = process.env.STORAGE_ACCOUNT || "photoshare123";
const CONTAINER_NAME = "photos";
const METADATA_CONTAINER = "metadata";
const SAS_TOKEN = process.env.SAS_TOKEN || "sv=2024-11-04&ss=b&srt=co&sp=rwdctfx&se=2026-01-07T04:01:36Z&st=2026-01-06T19:46:36Z&spr=https&sig=JzbWbKVLzdBwWMmaZ6KeG2qRLRJui%2Ft8U1On3VPbqKU%3D";
const BLOB_SERVICE_URL = `https://${STORAGE_ACCOUNT}.blob.core.windows.net`;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Helper function
async function streamToString(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', (data) => chunks.push(data.toString()));
        readableStream.on('end', () => resolve(chunks.join('')));
        readableStream.on('error', reject);
    });
}

// Get Blob Service Client
function getBlobServiceClient() {
    return new BlobServiceClient(`${BLOB_SERVICE_URL}?${SAS_TOKEN}`);
}

// ============================================
// API ROUTES
// ============================================

// Auth - Login
app.post('/api/auth/login', (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
        return res.status(400).json({ error: 'Username, password, and role required' });
    }

    const user = {
        id: Date.now().toString(),
        username,
        role,
        token: Buffer.from(`${username}:${Date.now()}`).toString('base64')
    };

    res.json({ user });
});

// Get all photos
app.get('/api/photos', async (req, res) => {
    try {
        const blobServiceClient = getBlobServiceClient();
        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);

        const photos = [];
        for await (const blob of metadataContainer.listBlobsFlat()) {
            if (blob.name.endsWith('.json')) {
                const blobClient = metadataContainer.getBlobClient(blob.name);
                const downloadResponse = await blobClient.download();
                const photoData = await streamToString(downloadResponse.readableStreamBody);
                photos.push(JSON.parse(photoData));
            }
        }

        photos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        res.json(photos);
    } catch (error) {
        console.error('Error fetching photos:', error);
        res.status(500).json({ error: 'Failed to fetch photos', details: error.message });
    }
});

// Upload photo
app.post('/api/photos', async (req, res) => {
    try {
        const { title, caption, location, tags, imageData, fileName } = req.body;

        if (!title || !imageData || !fileName) {
            return res.status(400).json({ error: 'Title, imageData, and fileName required' });
        }

        const authHeader = req.headers.authorization || '';
        const username = authHeader ? 
            Buffer.from(authHeader.replace('Bearer ', ''), 'base64').toString().split(':')[0] : 
            'Anonymous';

        const photoId = Date.now().toString();
        const blobName = `${photoId}-${fileName}`;

        const blobServiceClient = getBlobServiceClient();
        const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        const base64Data = imageData.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');

        await blockBlobClient.upload(buffer, buffer.length, {
            blobHTTPHeaders: { blobContentType: 'image/jpeg' }
        });

        const imageUrl = `${BLOB_SERVICE_URL}/${CONTAINER_NAME}/${blobName}?${SAS_TOKEN}`;

        const photo = {
            id: photoId,
            title,
            caption: caption || '',
            location: location || '',
            tags: tags || '',
            url: imageUrl,
            creatorName: username,
            likes: 0,
            comments: [],
            rating: 0,
            ratingCount: 0,
            uploadedAt: new Date().toISOString()
        };

        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);
        const metadataBlobClient = metadataContainer.getBlockBlobClient(`${photoId}.json`);
        await metadataBlobClient.upload(
            JSON.stringify(photo),
            JSON.stringify(photo).length,
            { blobHTTPHeaders: { blobContentType: 'application/json' } }
        );

        res.status(201).json(photo);
    } catch (error) {
        console.error('Error uploading photo:', error);
        res.status(500).json({ error: 'Failed to upload photo', details: error.message });
    }
});

// Delete photo
app.delete('/api/photos/:photoId', async (req, res) => {
    try {
        const { photoId } = req.params;
        const blobServiceClient = getBlobServiceClient();

        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);
        const metadataBlobClient = metadataContainer.getBlobClient(`${photoId}.json`);

        const exists = await metadataBlobClient.exists();
        if (!exists) {
            return res.status(404).json({ error: 'Photo not found' });
        }

        const downloadResponse = await metadataBlobClient.download();
        const photoData = await streamToString(downloadResponse.readableStreamBody);
        const photo = JSON.parse(photoData);

        const urlParts = photo.url.split('/');
        const blobNameWithParams = urlParts[urlParts.length - 1];
        const blobName = blobNameWithParams.split('?')[0];

        const photoContainer = blobServiceClient.getContainerClient(CONTAINER_NAME);
        const imageBlobClient = photoContainer.getBlobClient(blobName);
        await imageBlobClient.delete();
        await metadataBlobClient.delete();

        res.json({ message: 'Photo deleted successfully', photoId });
    } catch (error) {
        console.error('Error deleting photo:', error);
        res.status(500).json({ error: 'Failed to delete photo', details: error.message });
    }
});

// Like photo
app.post('/api/photos/:photoId/like', async (req, res) => {
    try {
        const { photoId } = req.params;
        const blobServiceClient = getBlobServiceClient();

        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);
        const metadataBlobClient = metadataContainer.getBlobClient(`${photoId}.json`);

        const downloadResponse = await metadataBlobClient.download();
        const photoData = await streamToString(downloadResponse.readableStreamBody);
        const photo = JSON.parse(photoData);

        photo.likes++;

        await metadataBlobClient.upload(
            JSON.stringify(photo),
            JSON.stringify(photo).length,
            { blobHTTPHeaders: { blobContentType: 'application/json' } }
        );

        res.json({ success: true, likes: photo.likes });
    } catch (error) {
        console.error('Error liking photo:', error);
        res.status(500).json({ error: 'Failed to like photo', details: error.message });
    }
});

// Rate photo
app.post('/api/photos/:photoId/rate', async (req, res) => {
    try {
        const { photoId } = req.params;
        const { rating } = req.body;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5' });
        }

        const blobServiceClient = getBlobServiceClient();
        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);
        const metadataBlobClient = metadataContainer.getBlobClient(`${photoId}.json`);

        const downloadResponse = await metadataBlobClient.download();
        const photoData = await streamToString(downloadResponse.readableStreamBody);
        const photo = JSON.parse(photoData);

        const newRatingCount = photo.ratingCount + 1;
        photo.rating = ((photo.rating * photo.ratingCount) + rating) / newRatingCount;
        photo.ratingCount = newRatingCount;

        await metadataBlobClient.upload(
            JSON.stringify(photo),
            JSON.stringify(photo).length,
            { blobHTTPHeaders: { blobContentType: 'application/json' } }
        );

        res.json({ success: true, rating: photo.rating, ratingCount: photo.ratingCount });
    } catch (error) {
        console.error('Error rating photo:', error);
        res.status(500).json({ error: 'Failed to rate photo', details: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`PhotoShare server running on port ${PORT}`);
    console.log(`Access at: http://localhost:${PORT}`);
});
// ============================================
// FILE: package.json
// ============================================
/*
{
  "name": "photoshare-webapp",
  "version": "1.0.0",
  "description": "PhotoShare Cloud Native Platform",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "engines": {
    "node": "18.x"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "@azure/storage-blob": "^12.17.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
*/

// ============================================
// FILE: web.config (for Azure Web App)
// ============================================
/*
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <handlers>
      <add name="iisnode" path="server.js" verb="*" modules="iisnode"/>
    </handlers>
    <rewrite>
      <rules>
        <rule name="NodeInspector" patternSyntax="ECMAScript" stopProcessing="true">
          <match url="^server.js\/debug[\/]?" />
        </rule>
        <rule name="StaticContent">
          <action type="Rewrite" url="public{REQUEST_URI}"/>
        </rule>
        <rule name="DynamicContent">
          <conditions>
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="True"/>
          </conditions>
          <action type="Rewrite" url="server.js"/>
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <hiddenSegments>
          <remove segment="bin"/>
        </hiddenSegments>
      </requestFiltering>
    </security>
    <httpErrors existingResponse="PassThrough" />
  </system.webServer>
</configuration>
*/

// ============================================
// FILE: .deployment
// ============================================
/*
[config]
command = deploy.cmd
*/

// ============================================
// FILE: deploy.cmd (Deployment Script)
// ============================================
/*
@echo off
echo Installing dependencies...
call npm install --production
echo Deployment complete!
*/
