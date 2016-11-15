/*global require, Buffer, exports, GLOBAL, process*/
'use strict';
var fs = require('fs');
var toml = require('toml');
var log = require('./logger').logger.getLogger('Main');

var config;
try {
  config = toml.parse(fs.readFileSync('./portal.toml'));
} catch (e) {
  log.error('Parsing config error on line ' + e.line + ', column ' + e.column + ': ' + e.message);
  process.exit(1);
}

// Configuration default values
config.portal = config.portal || {};
config.portal.ip_address = config.portal.ip_address || '';
config.portal.hostname = config.portal.hostname|| '';
config.portal.port = config.portal.port || 8080;
config.portal.rest_port = config.portal.rest_port || 8081;
config.portal.ssl = config.portal.ssl || false;
config.portal.roles = config.portal.roles || {'admin':{'publish': true, 'subscribe':true, 'record':true, 'addExternalOutput':true}, 'presenter':{'publish': true, 'subscribe':true, 'record':true, 'addExternalOutput':true}, 'audio_only_presenter':{'publish': {'audio': true}, 'subscribe':{'audio': true}}, 'viewer':{'subscribe':true}, 'video_only_viewer':{'subscribe':{'video': true}}, 'no_text_viewer': {'subscribe': true, 'text': false}};

config.cluster = config.cluster || {};
config.cluster.name = config.cluster.name || 'woogeen-cluster';
config.cluster.join_retry = config.cluster.join_retry || 60;
config.cluster.keep_alive_interval = config.cluster.keep_alive_interval || 800;
config.cluster.report_load_interval = config.cluster.report_load_interval || 1000;
config.cluster.max_load = config.cluster.max_laod || 0.85;
config.cluster.network_max_scale = config.cluster.network_max_scale || 1000;

config.rabbit = config.rabbit || {};
config.rabbit.host = config.rabbit.host || 'localhost';
config.rabbit.port = config.rabbit.port || 5672;


var amqper = require('./amqp_client')();
var rpcClient;
var socketio_server;
var rest_server;
var worker;

var ip_address;
(function getPublicIP() {
  var BINDED_INTERFACE_NAME = config.portal.networkInterface;
  var interfaces = require('os').networkInterfaces(),
    addresses = [],
    k,
    k2,
    address;

  for (k in interfaces) {
    if (interfaces.hasOwnProperty(k)) {
      for (k2 in interfaces[k]) {
        if (interfaces[k].hasOwnProperty(k2)) {
          address = interfaces[k][k2];
          if (address.family === 'IPv4' && !address.internal) {
            if (k === BINDED_INTERFACE_NAME || !BINDED_INTERFACE_NAME) {
              addresses.push(address.address);
            }
          }
        }
      }
    }
  }

  if (config.portal.ip_address === '' || config.portal.ip_address === undefined){
    ip_address = addresses[0];
  } else {
    ip_address = config.portal.ip_address;
  }
})();

var getTokenKey = function(id, on_key, on_error) {
  rpcClient && rpcClient.remoteCall('nuve', 'getKey', id, {
    callback: function (key) {
      if (key === 'error' || key === 'timeout') {
        log.info('Failed to get token key.');
        return on_error();
      }
      on_key(key);
    }
  });
};

var joinCluster = function (on_ok) {
  var joinOK = on_ok;

  var joinFailed = function (reason) {
    log.error('portal join cluster failed. reason:', reason);
    worker && worker.quit();
    process.exit();
  };

  var loss = function () {
    log.info('portal lost.');
  };

  var recovery = function () {
    log.info('portal recovered.');
  };

  var spec = {rpcClient: rpcClient,
              purpose: 'portal',
              clusterName: config.cluster.name,
              joinRetry: config.cluster.join_retry,
              keepAlivePeriod: config.cluster.keep_alive_interval,
              info: {ip: ip_address,
                     hostname: config.portal.hostname,
                     port: config.portal.port,
                     rest_port: config.portal.rest_port,
                     ssl: config.portal.ssl,
                     state: 2,
                     max_load: config.cluster.max_load
                    },
              onJoinOK: joinOK,
              onJoinFailed: joinFailed,
              onLoss: loss,
              onRecovery: recovery,
              loadCollection: {period: config.cluster.report_load_interval,
                               item: {name: 'cpu'}}
             };

  worker = require('./clusterWorker')(spec);
};

var refreshTokenKey = function(id, portal, tokenKey) {
  var interval = setInterval(function() {
    getTokenKey(id, function(newTokenKey) {
      (socketio_server === undefined) && clearInterval(interval);
      if (newTokenKey !== tokenKey) {
        log.info('Token key updated!');
        portal.updateTokenKey(newTokenKey);
        tokenKey = newTokenKey;
      }
    }, function() {
      (socketio_server === undefined) && clearInterval(interval);
      log.warn('Keep trying...');
    });
  }, 6 * 1000);
};

var startServers = function(id, tokenKey) {
  var rpcChannel = require('./rpcChannel')(rpcClient);
  var rpcReq = require('./rpcRequest')(rpcChannel);

  var portal = require('./portal')({tokenKey: tokenKey,
                                    tokenServer: 'nuve',
                                    clusterName: config.cluster.name,
                                    selfRpcId: id,
                                    permissionMap: config.portal.roles},
                                    rpcReq);
  socketio_server = require('./socketIOServer')({port: config.portal.port, ssl: config.portal.ssl, keystorePath: config.portal.keystorePath}, portal);
  rest_server = require('./restServer')({port: config.portal.rest_port, ssl: config.portal.ssl, keystorePath: config.portal.keystorePath}, portal);
  return socketio_server.start()
    .then(function() {
      log.info('start socket.io server ok.');
      return rest_server.start();
    })
    .then(function() {
      log.info('start rest server ok.');
      refreshTokenKey(id, portal, tokenKey);
    })
    .catch(function(err) {
      log.error('Failed to start servers, reason:', err.message);
      throw err;
    });
};

var stopServers = function() {
  socketio_server && socketio_server.stop();
  socketio_server = undefined;
  rest_server && rest_server.stop();
  rest_server = undefined;
  worker && worker.quit();
  worker = undefined;
};

var rpcPublic = {
  drop: function(participantId, fromRoom, callback) {
    socketio_server &&  socketio_server.drop(participantId, fromRoom);
    rest_server &&  rest_server.drop(participantId, fromRoom);
    callback('callback', 'ok');
  },
  notify: function(participantId, event, data, callback) {
    socketio_server && socketio_server.notify(participantId, event, data);
    rest_server && rest_server.notify(participantId, event, data);
    callback('callback', 'ok');
  },
  setMute: function(participantId, streamId, muted, callback) {
    if (socketio_server) {
      socketio_server.updateMuteState(participantId, streamId, muted)
      .then(function() {
        callback('callback', 'ok');
      }).catch(function(reason) {
        callback('callback', 'error', reason);
      });
    } else {
      callback('callback', 'error', 'socketio server is not ready');
    }
  },
  setPermission: function(targetId, act, updatedValue, callback) {
    if (socketio_server) {
      socketio_server.updatePermission(targetId, act, updatedValue)
      .then(function() {
        callback('callback', 'ok');
      }).catch(function(reason) {
        callback('callback', 'error', reason);
      });
    } else {
      callback('callback', 'error', 'socketio server is not ready');
    }
  }
};

amqper.connect(config.rabbit, function () {
  amqper.asRpcClient(function(rpcClnt) {
    rpcClient = rpcClnt;
    log.info('portal initializing as rpc client ok');
    joinCluster(function(id) {
      log.info('portal join cluster ok, with rpcID:', id);
        amqper.asRpcServer(id, rpcPublic, function(rpcSvr) {
          log.info('portal initializing as rpc server ok');
          getTokenKey(id, function(tokenKey) {
            startServers(id, tokenKey);
          }, function() {
            worker && worker.quit();
            return process.exit();
          });
      }, function(reason) {
        log.error('portal initializing as rpc client failed, reason:', reason);
        stopServers();
        process.exit();
      });
    });
  }, function(reason) {
    log.error('portal initializing as rpc client failed, reason:', reason);
    stopServers();
    process.exit();
  });
}, function(reason) {
    log.error('portal connect to rabbitMQ server failed, reason:', reason);
    process.exit();
});

['SIGINT', 'SIGTERM'].map(function (sig) {
  process.on(sig, function () {
    log.warn('Exiting on', sig);
    stopServers();
    process.exit();
  });
});

process.on('exit', function () {
    amqper.disconnect();
});
