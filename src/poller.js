var request = require('superagent');
var Q = require('q');
var logger = require('./logger');
var http = require('http');
var moment = require('moment');
var url = require('url');
var cheerio = require('cheerio');

var lastPolled = null;
var ftApiURLRoot = process.env.FT_API_URL;
var stamperUrl = process.env.STAMPER_URL;
var stamper = url.parse(stamperUrl);
var API_KEY = process.env.FT_API_KEY;

function getNotifications() {

  var deferred = Q.defer();
  logger.log('info', 'Loading notifications since %s', moment(lastPolled).format());
  request
    .get(ftApiURLRoot + '/content/notifications')
    .query({
      since : lastPolled.toISOString(),
      apiKey : API_KEY
    })
    .end(function(err, response) {
      if (err) {
        logger.log('error', 'Error getting notifications', {
          error: err.message
        });
        return deferred.reject(err);
      }
      logger.log('info', 'Got %s notifications', response.body.notifications.length);
      deferred.resolve(response.body.notifications);
    });

  return deferred.promise;
}

function processNotification(notification) {

  var deferred = Q.defer();

  fetchArticle(notification)
    .then(checkForPNGs)
    .then(function(stamps) {
      logger.log('verbose', 'Notification processed', notification.uuid);
      deferred.resolve(stamps);
    });

  return deferred.promise;

}


function fetchArticle(notification) {
  var deferred = Q.defer();
  logger.log('verbose', 'Loading article %s', notification.apiUrl);
  request
    .get(notification.apiUrl)
    .query({
        apiKey : API_KEY
    })
    .end(function (err, response) {
      if (err) {
        logger.log('error', 'Error getting article %s', notification.apiUrl, {
          error: err.message,
          notification: notification
        });
        return deferred.reject(err);
      }
      logger.log('verbose', 'Loaded article %s', notification.apiUrl);
      deferred.resolve(response.body);
    });

  return deferred.promise;

}

function checkForPNGs(articleJSON) {
  // var articleJSON = promise.value;
  var deferred = Q.defer();
  var imageSetUrls = [];

  var $ = cheerio.load(articleJSON.bodyXML);

  $('ft-content[type*="/ImageSet"]')
    .each(function(d) {
      imageSetUrls.push(this.attribs.url);
    });

  logger.log('debug', 'Checking article for PNG images');
  var promises = imageSetUrls.map(crawlImageSet);

  Q.allSettled(promises).then(function(urls) {
    if (!urls.length) {
      return;
    }
    logger.log('verbose', 'All ImageSets crawled, found %s images', urls.length);
    var promises = urls.map(downloadImage);

    Q.allSettled(promises).then(function(stamps) {
      var procStamps = [];
      stamps.forEach(function(s) {
        if (s.state != 'fulfilled') {
          return;
        }

        if (!s.value) {
          return;
        }

        var val = s.value;
        procStamps.push(val)
        logger.log('verbose', 'Stamps %j', val, {});
      });
      if (!procStamps) {
        deferred.reject(procStamps);
      }

      logger.log('info', 'The article %s contained the following stamps %j', articleJSON.id, procStamps, {});

      deferred.resolve(stamps);

    });

  });

  return deferred.promise;

}

function crawlImageSet(url) {
  var deferred = Q.defer();
  request
    .get(url)
    .query({
        apiKey : API_KEY
    })
    .end(function (err, response) {
      if (err) {
        logger.log('error', 'Error getting ImageSet %s', url, {
          error: err.message,
          url: url
        });
        return deferred.reject(err);
      }
      imageUrl = response.body.members[0].id;
      request
        .get(imageUrl)
        .query({
            apiKey : API_KEY
        }).end(function (err, response) {
          if (err) {
            logger.log('error', 'Error getting ImageSet Member %s', imageUrl, {
              error: err.message,
              imageUrl: imageUrl
            });
            return deferred.reject(err);
          }
          logger.log('debug', 'Got binary url for ImageSet member %s', imageUrl);
          deferred.resolve(response.body.binaryUrl);
        });
    });
  return deferred.promise;
}


function downloadImage(promise)  {
  if (promise.state !== 'fulfilled') return;
  var url = promise.value;
  var path = require('path');
  var uuid = path.basename(url);
  var filePath = path.join('tmp', uuid + '.png');

  logger.log('debug', 'Downloading image %s from S3', uuid);

  var deferred = Q.defer();

  request
    .get(url)
    .end(function(err, response) {
      if (err) {
        logger.log('error', 'Error downloading image %s from S3', uuid, {
          error: err.message,
          uuid: uuid
        });
        deferred.reject(err);
      }

      if (response.headers['content-type'] !== 'image/png') {
        logger.log('debug', 'Image %s is not a PNG - Ignoring', uuid);
        return;
      }
      logger.log('verbose', 'Image %s is a PNG, looking for stamps', uuid);
      var req = http.request({
        hostname: stamper.hostname,
        port: stamper.port,
        method: 'POST',
        path: '/read',
        headers: {
          'Content-Type': 'image/png'
        }
      }, function(res) {
        res.on('data', function(data) {
          var stamps = JSON.parse(data.toString('utf-8'));
          logger.log('debug', 'Loaded %s stamps for %s', stamps.length, uuid, {});
          stamps.forEach(function(s) {
            logger.log('debug', 'Stamp: %j', s, {});
          });
          deferred.resolve(stamps);
        });
        res.on('error', function(error) {
          logger.log('error', 'Error loading stamps for %s', uuid, {
            error: err.message
          });
          deferred.reject(err);
        });
      });
      req.write(response.body);
      req.end();
    });

    return deferred.promise;

}


module.exports = {

  lastPolled: function() {
    return lastPolled;
  },

  poll: function() {

    if (!lastPolled) {
      // start polling three hours ago
      lastPolled = new Date(new Date().getTime() - 1 * 60 * 60 * 1000);
    } else {
      lastPolled = new Date();
    }

    getNotifications()
      .then(function(notifications) {
        logger.log('verbose', 'Fetching %s articles', notifications.length);
        var promises = notifications.map(processNotification);

        var deferred = Q.defer();

        Q.allSettled(promises)
          .then(function(stamps) {
            logger.log('info', 'All articles processed', stamps);
            deferred.resolve(stamps);
          });

        return deferred.promise;

      })
      .then(function(stamps) {
        logger.log('debug', 'Stamps found:', stamps);
      });
  }
};