const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const CACHE_TTL = 15000; // 15 seconds cache

// Simple in-memory cache
const cache = new Map();

// Helper function to fetch from ThingSpeak with retry
function fetchFromThingSpeak(channel, apiKey, retries = 3) {
  return new Promise((resolve, reject) => {
    const thingspeakUrl = `https://api.thingspeak.com/channels/${channel}/fields/1.json?results=1&api_key=${apiKey}`;
    
    const attemptFetch = (attemptsLeft) => {
      https.get(thingspeakUrl, {
        timeout: 5000,
        headers: {
          'User-Agent': 'ThingSpeak-Proxy/1.0'
        }
      }, (thingspeakRes) => {
        let data = '';
        
        thingspeakRes.on('data', (chunk) => {
          data += chunk;
        });
        
        thingspeakRes.on('end', () => {
          if (thingspeakRes.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (error) {
              reject(new Error('Failed to parse JSON response'));
            }
          } else {
            reject(new Error(`HTTP ${thingspeakRes.statusCode}`));
          }
        });
      }).on('error', (error) => {
        if (attemptsLeft > 0) {
          console.log(`Retry attempt ${retries - attemptsLeft + 1}/${retries}...`);
          setTimeout(() => attemptFetch(attemptsLeft - 1), 1000);
        } else {
          reject(error);
        }
      }).on('timeout', () => {
        if (attemptsLeft > 0) {
          console.log(`Timeout, retrying... ${attemptsLeft - 1} attempts left`);
          setTimeout(() => attemptFetch(attemptsLeft - 1), 1000);
        } else {
          reject(new Error('Request timeout'));
        }
      });
    };
    
    attemptFetch(retries);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Логування запиту
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  // Health check endpoint
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ThingSpeak Proxy is running\nUsage: /field?num=1&channel=3195161&key=YOUR_API_KEY');
    return;
  }
  
  // Favicon - ignore
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Парсинг URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const field = url.searchParams.get('num') || url.searchParams.get('field');
  const channel = url.searchParams.get('channel');
  const apiKey = url.searchParams.get('key') || url.searchParams.get('api_key');
  
  // Перевірка параметрів
  if (!field) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('ERROR: Missing field parameter\nUsage: /field?num=1&channel=3195161&key=YOUR_API_KEY');
    return;
  }
  
  if (!channel) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('ERROR: Missing channel parameter\nUsage: /field?num=1&channel=3195161&key=YOUR_API_KEY');
    return;
  }
  
  if (!apiKey) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('ERROR: Missing API key parameter\nUsage: /field?num=1&channel=3195161&key=YOUR_API_KEY');
    return;
  }
  
  // Валідація field (1-8, ThingSpeak має до 8 полів)
  const fieldNum = parseInt(field);
  if (isNaN(fieldNum) || fieldNum < 1 || fieldNum > 8) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('ERROR: field must be between 1 and 8');
    return;
  }
  
  // Check cache
  const cacheKey = `${channel}_${apiKey}`;
  const cached = cache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    const fieldKey = `field${fieldNum}`;
    const value = cached.data.channel[fieldKey] || '0';
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(value);
    console.log(`  -> [CACHED] channel:${channel} field${fieldNum} = ${value}`);
    return;
  }
  
  // Fetch from ThingSpeak
  try {
    const json = await fetchFromThingSpeak(channel, apiKey);
    
    // Update cache
    cache.set(cacheKey, {
      data: json,
      timestamp: Date.now()
    });
    
    const fieldKey = `field${fieldNum}`;
    const value = json.channel[fieldKey] || '0';
    
    // Повертаємо просто число
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(value);
    
    console.log(`  -> channel:${channel} field${fieldNum} = ${value}`);
  } catch (error) {
    console.error('ThingSpeak request error:', error.message);
    
    // Try to return cached value even if expired
    const cached = cache.get(cacheKey);
    if (cached) {
      const fieldKey = `field${fieldNum}`;
      const value = cached.data.channel[fieldKey] || '0';
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(value);
      console.log(`  -> [STALE CACHE] channel:${channel} field${fieldNum} = ${value}`);
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('ERROR: Failed to fetch data from ThingSpeak');
    }
  }
});

server.listen(PORT, () => {
  console.log(`ThingSpeak Proxy Server running on port ${PORT}`);
  console.log('Ready to proxy requests');
  console.log('');
});
