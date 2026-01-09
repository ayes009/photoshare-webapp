const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8080;

const CONNECTION_STRING = "BlobEndpoint=https://photoshare123.blob.core.windows.net/;QueueEndpoint=https://photoshare123.queue.core.windows.net/;FileEndpoint=https://photoshare123.file.core.windows.net/;TableEndpoint=https://photoshare123.table.core.windows.net/;SharedAccessSignature=sv=2024-11-04&ss=b&srt=co&sp=rwdctfx&se=2026-01-07T04:01:36Z&st=2026-01-06T19:46:36Z&spr=https&sig=JzbWbKVLzdBwWMmaZ6KeG2qRLRJui%2Ft8U1On3VPbqKU%3D";
const blobServiceClient = BlobServiceClient.fromConnectionString(CONNECTION_STRING);

const USERS_CONTAINER = 'users';
const PHOTOS_CONTAINER = 'photos';
const IMAGES_CONTAINER = 'images';
const JWT_SECRET = 'photoshare-secret-key-2024';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

async function ensureContainer(containerName) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists({ access: 'blob' });
  return containerClient;
}

async function getBlobData(containerName, blobName) {
  try {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);
    const downloadResponse = await blobClient.download();
    const downloaded = await streamToBuffer(downloadResponse.readableStreamBody);
    return JSON.parse(downloaded.toString());
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function saveBlobData(containerName, blobName, data) {
  const containerClient = await ensureContainer(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  const content = JSON.stringify(data);
  await blockBlobClient.upload(content, content.length, {
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });
}

async function listAllBlobs(containerName) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobs = [];
  for await (const blob of containerClient.listBlobsFlat()) {
    const data = await getBlobData(containerName, blob.name);
    if (data) blobs.push(data);
  }
  return blobs;
}

async function deleteBlob(containerName, blobName) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  await blobClient.delete();
}

async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on('end', () => resolve(Buffer.concat(chunks)));
    readableStream.on('error', reject);
  });
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

async function initializeContainers() {
  await ensureContainer(USERS_CONTAINER);
  await ensureContainer(PHOTOS_CONTAINER);
  await ensureContainer(IMAGES_CONTAINER);
  console.log('Containers initialized');
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'All fields required' });
    }
    const existingUser = await getBlobData(USERS_CONTAINER, `${username}.json`);
    if (existingUser) return res.status(400).json({ error: 'Username exists' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      username,
      password: hashedPassword,
      role,
      createdAt: new Date().toISOString()
    };
    await saveBlobData(USERS_CONTAINER, `${username}.json`, user);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
    
    const user = await getBlobData(USERS_CONTAINER, `${username}.json`);
    if (!user || user.role !== role) return res.status(401).json({ error: 'Invalid credentials' });
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/photos', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { title, caption, location, tags } = req.body;
    const file = req.file;
    if (!title) return res.status(400).json({ error: 'Title required' });
    
    let imageUrl = '';
    if (file) {
      const photoId = uuidv4();
      const blobName = `${photoId}-${file.originalname}`;
      const containerClient = await ensureContainer(IMAGES_CONTAINER);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.upload(file.buffer, file.buffer.length, {
        blobHTTPHeaders: { blobContentType: file.mimetype }
      });
      imageUrl = blockBlobClient.url;
    } else if (req.body.imageUrl) {
      imageUrl = req.body.imageUrl;
    } else {
      return res.status(400).json({ error: 'Image required' });
    }
    
    const photoId = uuidv4();
    const photo = {
      id: photoId,
      url: imageUrl,
      title,
      caption: caption || '',
      location: location || '',
      tags: tags || '',
      creatorId: req.user.id,
      creatorName: req.user.username,
      likes: 0,
      likedBy: [],
      comments: [],
      rating: 0,
      ratingCount: 0,
      uploadedAt: new Date().toISOString()
    };
    await saveBlobData(PHOTOS_CONTAINER, `${photoId}.json`, photo);
    res.status(201).json(photo);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/photos', authenticateToken, async (req, res) => {
  try {
    const photos = await listAllBlobs(PHOTOS_CONTAINER);
    photos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json(photos);
  } catch (error) {
    console.error('Get photos error:', error);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

app.delete('/api/photos/:id', authenticateToken, async (req, res) => {
  try {
    const photo = await getBlobData(PHOTOS_CONTAINER, `${req.params.id}.json`);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    if (photo.creatorId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    await deleteBlob(PHOTOS_CONTAINER, `${req.params.id}.json`);
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.post('/api/photos/:id/like', authenticateToken, async (req, res) => {
  try {
    const photo = await getBlobData(PHOTOS_CONTAINER, `${req.params.id}.json`);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    if (!photo.likedBy.includes(req.user.id)) {
      photo.likedBy.push(req.user.id);
      photo.likes += 1;
      await saveBlobData(PHOTOS_CONTAINER, `${req.params.id}.json`, photo);
    }
    res.json(photo);
  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ error: 'Like failed' });
  }
});

app.post('/api/photos/:id/comment', authenticateToken, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Comment text required' });
    const photo = await getBlobData(PHOTOS_CONTAINER, `${req.params.id}.json`);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const comment = {
      id: uuidv4(),
      userId: req.user.id,
      username: req.user.username,
      text,
      timestamp: new Date().toISOString()
    };
    photo.comments.push(comment);
    await saveBlobData(PHOTOS_CONTAINER, `${req.params.id}.json`, photo);
    res.json(comment);
  } catch (error) {
    console.error('Comment error:', error);
    res.status(500).json({ error: 'Comment failed' });
  }
});

app.post('/api/photos/:id/rate', authenticateToken, async (req, res) => {
  try {
    const { rating } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1-5' });
    }
    const photo = await getBlobData(PHOTOS_CONTAINER, `${req.params.id}.json`);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const newRatingCount = photo.ratingCount + 1;
    const newRating = ((photo.rating * photo.ratingCount) + rating) / newRatingCount;
    photo.rating = newRating;
    photo.ratingCount = newRatingCount;
    await saveBlobData(PHOTOS_CONTAINER, `${req.params.id}.json`, photo);
    res.json(photo);
  } catch (error) {
    console.error('Rate error:', error);
    res.status(500).json({ error: 'Rate failed' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

initializeContainers().then(() => {
  app.listen(PORT, () => {
    console.log(`PhotoShare API running on port ${PORT}`);
  });
}).catch(error => {
  console.error('Failed to initialize:', error);
  process.exit(1);
});
