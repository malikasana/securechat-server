require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  FOUNDER_KEY: process.env.FOUNDER_KEY,
  SERVER_NAME: process.env.SERVER_NAME || 'SecureChat Server',
};
