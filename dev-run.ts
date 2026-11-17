import { createApp } from './app.ts';
const server = createApp();
server.listen(8791, '127.0.0.1', () => console.log('dev forge on 8791'));
