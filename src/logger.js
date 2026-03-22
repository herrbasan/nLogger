/**
 * Zero-dependency logging utility
 *
 * Features:
 * - Timestamped session log files (one per session)
 * - Combined rolling main log (main-0.log, main-1.log, etc.)
 * - JSON Lines format for main log (machine-parseable)
 * - Structured log format with event types
 * - Automatic log rotation (configurable retention)
 * - Multiple log levels (INFO, WARN, ERROR, DEBUG)
 * - JSON metadata support
 * - Write buffering for better I/O performance
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_LOG_RETENTION_DAYS = 1;
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_MAIN_LOG_FILES = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/**
 * Logger class - handles file-based logging with structured formatting
 */
class Logger {
    /**
     * @param {object} options
     * @param {string} options.logsDir - Directory for log files (default: ../../logs relative to this file)
     * @param {string} options.sessionPrefix - Prefix for session ID (default: 'gw')
     * @param {boolean} options.enableMainLog - Enable combined rolling log (default: true)
     * @param {string} options.mainLogPrefix - Prefix for main log files (default: 'main')
     * @param {number} options.maxFileSizeBytes - Max size per main log file (default: 10MB)
     * @param {number} options.maxMainLogFiles - Max main log files to keep (default: 10)
     * @param {number} options.flushIntervalMs - Force flush interval (default: 1000ms)
     */
    constructor(options = {}) {
        this.logsDir = options.logsDir || path.resolve(__dirname, '../../logs');
        this.sessionPrefix = options.sessionPrefix || 'gw';

        // Main log options
        this.enableMainLog = options.enableMainLog !== false;
        this.mainLogPrefix = options.mainLogPrefix || 'main';
        this.maxFileSizeBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES;
        this.maxMainLogFiles = options.maxMainLogFiles || DEFAULT_MAX_MAIN_LOG_FILES;
        this.flushIntervalMs = options.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;

        this.logFile = null;
        this.logStream = null;
        this.startTime = new Date();
        this.sessionId = this._generateSessionId();
        this.logRetentionDays = this._resolveLogRetentionDays();

        // Main log state
        this._mainLogBuffer = [];
        this._mainLogCurrentSize = 0;
        this._mainLogFileIndex = 0;
        this._mainLogStream = null;
        this._flushTimer = null;

        this._initializeLogFile();

        if (this.enableMainLog) {
            this._initializeMainLog();
        }
    }
    
    _generateSessionId() {
        return `${this.sessionPrefix}-${Date.now().toString(36).slice(-6)}`;
    }
    
    _initializeLogFile() {
        // Ensure logs directory exists
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }

        this._pruneOldLogs();
        
        // Create timestamped filename: YYYY-MM-DD-HH-MM-SS-<prefix>-<sessionId>.log
        const timestamp = this.startTime.toISOString()
            .replace(/[:T]/g, '-')
            .slice(0, 19);
        const filename = `${timestamp}-${this.sessionId}.log`;
        this.logFile = path.join(this.logsDir, filename);
        
        // Create write stream (append mode)
        this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
        
        // Write startup header
        this._writeToFile(`\n========================================`);
        this._writeToFile(`Session: ${this.sessionId}`);
        this._writeToFile(`Started: ${this.startTime.toISOString()}`);
        this._writeToFile(`Log File: ${this.logFile}`);
        this._writeToFile(`Retention Days: ${this.logRetentionDays}`);
        this._writeToFile(`========================================\n`);
    }

    _resolveLogRetentionDays() {
        const rawValue = process.env.LOG_RETENTION_DAYS;
        if (rawValue == null || rawValue === '') {
            return DEFAULT_LOG_RETENTION_DAYS;
        }
        const parsed = Number(rawValue);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOG_RETENTION_DAYS;
    }

    _pruneOldLogs() {
        if (this.logRetentionDays <= 0) return;

        const cutoffMs = this.startTime.getTime() - (this.logRetentionDays * 24 * 60 * 60 * 1000);

        try {
            const entries = fs.readdirSync(this.logsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.log')) continue;

                const filePath = path.join(this.logsDir, entry.name);
                const stats = fs.statSync(filePath);
                if (stats.mtimeMs < cutoffMs) {
                    fs.unlinkSync(filePath);
                }
            }
        } catch (error) {
            // Log retention failures should not stop the app
            const fallback = `[${new Date().toISOString()}] [WARN] [System] Failed to prune old logs ${JSON.stringify({ error: error.message })}`;
            if (this.logStream) {
                this._writeToFile(fallback);
            }
        }
    }

    // ==================== Main Log (Rolling) ====================

    _initializeMainLog() {
        this._mainLogFileIndex = this._findLatestMainLogIndex();
        this._openMainLogStream();
        this._flushTimer = setInterval(() => this._flushBuffer(), this.flushIntervalMs);
    }

    _findLatestMainLogIndex() {
        let maxIndex = -1;
        try {
            const entries = fs.readdirSync(this.logsDir);
            for (const name of entries) {
                const match = name.match(/^main-(\d+)\.log$/);
                if (match) {
                    maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
                }
            }
        } catch (error) {
            // Ignore errors, start from 0
        }
        return maxIndex + 1;
    }

    _openMainLogStream() {
        const filename = `${this.mainLogPrefix}-${this._mainLogFileIndex}.log`;
        const filePath = path.join(this.logsDir, filename);

        this._mainLogStream = fs.createWriteStream(filePath, { flags: 'a' });

        try {
            const stats = fs.statSync(filePath);
            this._mainLogCurrentSize = stats.size;
        } catch {
            this._mainLogCurrentSize = 0;
        }
    }

    _writeToMainLog(level, type, message, meta) {
        const entry = {
            ts: new Date().toISOString(),
            level,
            type,
            msg: message,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
            session: this.sessionId
        };

        let line = JSON.stringify(entry) + '\n';
        const lineBytes = Buffer.byteLength(line, 'utf8');

        // Handle oversized entries
        if (lineBytes > this.maxFileSizeBytes) {
            entry.msg = entry.msg.substring(0, 1000) + '... [TRUNCATED]';
            line = JSON.stringify(entry) + '\n';
        }

        this._mainLogBuffer.push(line);
        this._mainLogCurrentSize += lineBytes;

        // Auto-flush if buffer is large enough
        if (this._mainLogBuffer.length >= 10) {
            this._flushBuffer();
        }

        this._rollMainLogIfNeeded();
    }

    _flushBuffer() {
        if (this._mainLogBuffer.length === 0 || !this._mainLogStream) {
            return;
        }

        const batch = this._mainLogBuffer.join('');
        const canContinue = this._mainLogStream.write(batch);
        this._mainLogBuffer = [];

        if (!canContinue) {
            this._mainLogStream.once('drain', () => {});
        }
    }

    _rollMainLogIfNeeded() {
        if (this._mainLogCurrentSize >= this.maxFileSizeBytes) {
            this._rollMainLog();
        }
    }

    _rollMainLog() {
        if (this._mainLogStream) {
            this._mainLogStream.end();
            this._mainLogStream = null;
        }

        this._mainLogFileIndex++;
        this._pruneMainLogs();
        this._openMainLogStream();
    }

    _pruneMainLogs() {
        try {
            const entries = fs.readdirSync(this.logsDir);
            const mainLogs = [];

            for (const name of entries) {
                const match = name.match(/^main-(\d+)\.log$/);
                if (match) {
                    mainLogs.push({
                        name,
                        index: parseInt(match[1], 10),
                        path: path.join(this.logsDir, name)
                    });
                }
            }

            // Sort by index descending
            mainLogs.sort((a, b) => b.index - a.index);

            // Delete files beyond maxMainLogFiles
            for (let i = this.maxMainLogFiles; i < mainLogs.length; i++) {
                fs.unlinkSync(mainLogs[i].path);
            }
        } catch (error) {
            // Log retention failures should not stop the app
        }
    }

    _closeMainLog() {
        this._flushBuffer();

        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }

        if (this._mainLogStream) {
            this._mainLogStream.end();
            this._mainLogStream = null;
        }
    }

    // ==================== Session Log Write ====================

    _writeToFile(message) {
        if (this.logStream) {
            this.logStream.write(message + '\n');
        }
    }
    
    /**
     * Format a log message
     * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
     * @param {string} type - Event type/category
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    _formatMessage(level, type, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const metaStr = Object.keys(meta).length > 0 
            ? ' ' + JSON.stringify(meta) 
            : '';
        return `[${timestamp}] [${level}] [${type}] ${message}${metaStr}`;
    }
    
    /**
     * Log an info message
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    info(message, meta = {}, type = 'System') {
        const formatted = this._formatMessage('INFO', type, message, meta);
        this._writeToFile(formatted);
        if (this.enableMainLog) {
            this._writeToMainLog('INFO', type, message, meta);
        }
    }
    
    /**
     * Log a warning message
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    warn(message, meta = {}, type = 'System') {
        const formatted = this._formatMessage('WARN', type, message, meta);
        this._writeToFile(formatted);
        if (this.enableMainLog) {
            this._writeToMainLog('WARN', type, message, meta);
        }
    }
    
    /**
     * Log an error message
     * @param {string} message - Log message
     * @param {Error|null} error - Error object
     * @param {object|null} meta - Additional metadata
     * @param {string} type - Event type/category (default: 'System')
     */
    error(message, error = null, meta = null, type = 'System') {
        const errorMeta = error ? {
            error: error.message,
            stack: error.stack,
            ...(meta || {})
        } : (meta || {});
        const formatted = this._formatMessage('ERROR', type, message, errorMeta);
        this._writeToFile(formatted);
        if (this.enableMainLog) {
            this._writeToMainLog('ERROR', type, message, errorMeta);
        }
    }
    
    /**
     * Log a debug message (only in development/DEBUG mode)
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    debug(message, meta = {}, type = 'System') {
        if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
            const formatted = this._formatMessage('DEBUG', type, message, meta);
            this._writeToFile(formatted);
            if (this.enableMainLog) {
                this._writeToMainLog('DEBUG', type, message, meta);
            }
        }
    }
    
    /**
     * Get current session info
     * @returns {object} Session info with sessionId, logFile, startedAt
     */
    getSessionInfo() {
        return {
            sessionId: this.sessionId,
            logFile: this.logFile,
            startedAt: this.startTime.toISOString()
        };
    }
    
    /**
     * Close the log stream gracefully
     * @param {string} [shutdownMessage] - Custom shutdown message
     */
    close(shutdownMessage = 'Shutting down') {
        if (this.logStream) {
            const duration = Date.now() - this.startTime.getTime();
            this._writeToFile(`\n[${new Date().toISOString()}] [INFO] [System] ${shutdownMessage}. Session duration: ${Math.round(duration / 1000)}s`);
            this.logStream.end();
            this.logStream = null;
        }

        if (this.enableMainLog) {
            this._closeMainLog();
        }
    }
}

// Singleton instance
let loggerInstance = null;

/**
 * Create a new logger instance (singleton)
 * @param {object} options - Logger options
 * @returns {Logger}
 */
export function createLogger(options = {}) {
    if (!loggerInstance) {
        loggerInstance = new Logger(options);
    }
    return loggerInstance;
}

/**
 * Get the current logger instance
 * @returns {Logger}
 */
export function getLogger() {
    if (!loggerInstance) {
        return createLogger();
    }
    return loggerInstance;
}

/**
 * Reset the logger instance (mainly for testing)
 */
export function resetLogger() {
    if (loggerInstance) {
        loggerInstance.close();
        loggerInstance = null;
    }
}
