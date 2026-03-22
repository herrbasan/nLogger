# Logger Module

Zero-dependency logging utility for Node.js projects.

## Usage as Git Submodule

### 1. Add to your project

```bash
# In your project root
git submodule add https://github.com/YOUR_USERNAME/logger.git vendor/logger
git submodule update --init --recursive
```

### 2. Create a wrapper (recommended)

Create `src/utils/logger.js` in your project:

```javascript
// src/utils/logger.js
// Wrapper for the logger submodule

import { createLogger, getLogger, resetLogger } from '../../vendor/logger/src/logger.js';

export { createLogger, getLogger, resetLogger };
```

### 3. Use in your code

```javascript
import { getLogger } from './utils/logger.js';

const logger = getLogger();

logger.info('Server started', { port: 3000 }, 'System');
logger.error('Database failed', err, null, 'Database');
```

## Updating the Logger

```bash
# Update to latest
cd vendor/logger
git pull origin main
cd ../..
git add vendor/logger
git commit -m "Update logger submodule"
```

## Project Structure

```
your-project/
├── src/
│   └── utils/
│       └── logger.js      # Wrapper that imports from submodule
├── vendor/                # Git submodules
│   └── logger/
│       └── src/
│           └── logger.js  # The actual logger
└── logs/                  # Log output directory
```

## Configuration

Environment variables:

```bash
LOG_RETENTION_DAYS=7    # Days to keep old logs (default: 1)
DEBUG=true              # Enable debug logging
NODE_ENV=development    # Also enables debug logging
```

## Log Format

```
[2026-03-22T14:33:26.713Z] [INFO] [ModelRouter] Message {"key":"value"}
```

Format: `[timestamp] [LEVEL] [TYPE] message {JSON metadata}`
