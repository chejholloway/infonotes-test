
// Alternative functional approach using modern JavaScript features
const decodeSecretMessage = async (googleDocUrl) => {
  const extractDocId = (url) => {
    const match = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error('Invalid Google Doc URL format');
    return match[1];
  };

  const getPlainTextUrl = (url) => 
    url.includes('/document/d/') 
      ? `https://docs.google.com/document/d/${extractDocId(url)}/export?format=txt`
      : url;

  const fetchWithRetry = async (url, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        if (attempt === maxRetries) throw error;
        console.warn(`Attempt ${attempt} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  };

  const parseCharacters = (content) => {
    const patterns = [
      /(.)\s+(\d+)\s+(\d+)/,
      /(.),\s*(\d+),\s*(\d+)/,
      /(\S+)\s+(\d+)\s+(\d+)/,
    ];

    return content
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        for (const pattern of patterns) {
          const match = line.match(pattern);
          if (match) {
            const [, char, x, y] = match;
            return { char, x: parseInt(x, 10), y: parseInt(y, 10) };
          }
        }
        return null;
      })
      .filter(Boolean);
  };

  try {
    const content = await fetchWithRetry(getPlainTextUrl(googleDocUrl));
    const characters = parseCharacters(content);
    
    if (!characters.length) {
      throw new Error('No character data found');
    }

    const bounds = characters.reduce(
      (acc, { x, y }) => ({
        minX: Math.min(acc.minX, x),
        maxX: Math.max(acc.maxX, x),
        minY: Math.min(acc.minY, y),
        maxY: Math.max(acc.maxY, y),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    );

    const grid = Array.from({ length: bounds.maxY - bounds.minY + 1 }, () =>
      Array.from({ length: bounds.maxX - bounds.minX + 1 }, () => ' ')
    );

    characters.forEach(({ char, x, y }) => {
      grid[y - bounds.minY][x - bounds.minX] = char;
    });

    console.log('Secret Message:');
    grid.forEach(row => console.log(row.join('')));

  } catch (error) {
    console.error(`Decoding failed: ${error.message}`);
    throw error;
  }
};

// Usage examples
export { SecretMessageDecoder, decodeSecretMessage };

// Example usage with top-level await (ES2022)
if (typeof window === 'undefined') {
  // Node.js environment
  const exampleUrl = "https://docs.google.com/document/d/e/2PACX-1vRPzbNQcx5UriHSbZ-9vmsTow_R6RRe7eyAU60xIF9Dlz-vaHiHNO2TKgDi7jy4ZpTpNqM7EvEcfr_p/pub";
  
  // Using functional approach
  // await decodeSecretMessage(exampleUrl);
  
  console.log('Secret Message Decoder ready. Import and use with your Google Doc URL.');
}