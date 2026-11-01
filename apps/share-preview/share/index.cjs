const { handleShare } = require('../handler.cjs');
module.exports = async function (context, req) {
  let config;
  try { config = require('../public-config.json'); } catch { /* fail closed */ }
  context.res = await handleShare(req, config);
};
