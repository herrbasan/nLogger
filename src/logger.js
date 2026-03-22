/**
 * Zero-dependency logging utility
 * 
 * Features:
 * - Timestamped log files (one per session)
 * - Structured log format with event types
 * - Automatic log rotation (configurable retention)
 * - Multiple log levels (INFO, WARN, ERROR, DEBUG)
 * - JSON metadata support
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_LOG_RETENTION_DAYS = 1;

/**
 * Logger class - handles file-based logging with structured formatting
 */
class Logger {
    /**
     * @param {object} options
     * @param {string} options.logsDir - Directory for log files (default: ../../logs relative to this file)
     * @param {string} options.sessionPrefix - Prefix for session ID (default: 'gw')
     */
    constructor(options = {}) {
        this.logsDir = options.logsDir || path.resolve(__dirname, '../../logs');
        this.sessionPrefix = options.sessionPrefix || 'gw';
        
        this.logFile = null;
        this.logStream = null;
        this.startTime = new Date();
        this.sessionId = this._generateSessionId();
        this.logRetentionDays = this._resolveLogRetentionDays();
        
        this._initializeLogFile();
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
