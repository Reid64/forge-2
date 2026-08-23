// FORGE benchmark fixture (legacy-resurrection): deliberately stale, callback-style code
// using a deprecated dependency ("request", archived on npm) that no longer ships. This
// module cannot run against a modern Node install. DISPOSABLE fixture; never a real project.

var request = require('request'); // deprecated, archived — will not resolve on a fresh install

function fetchStatus(url, callback) {
  request(url, function (err, response, body) {
    if (err) return callback(err);
    callback(null, body);
  });
}

module.exports = { fetchStatus };
