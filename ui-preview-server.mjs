import express from 'express';

const app = express();
app.use(express.static('public'));
app.listen(4173, '127.0.0.1', () => {
  console.log('UI validation server ready');
});
