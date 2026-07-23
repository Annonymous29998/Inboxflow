import { startWorkers } from '../services/email/queue.js';

console.log('Starting Inbox Flow workers...');
startWorkers();
