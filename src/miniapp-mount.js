'use strict';
const path = require('path');
const express = require('express');

module.exports = function mountMiniApp(app) {
  app.use('/api/miniapp', require('./miniapp-api'));
  const dir = path.join(__dirname, '..', 'public', 'miniapp');
  app.use('/miniapp', express.static(dir, {
    index: 'index.html',
    etag: true,
    maxAge: '5m'
  }));
  app.get('/miniapp', (req, res) => res.redirect(301, '/miniapp/'));
};
