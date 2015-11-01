'use strict';

// Node
var nodeUrl = require('url');
// 3rd
var debug = require('debug')('app:middleware');
var bouncer = require('koa-bouncer');
var _ = require('lodash');
var recaptcha = require('recaptcha-validator');
// 1st
var db = require('./db');
var config = require('./config');
var pre = require('./presenters');

// Assoc ctx.currUser if the session_id cookie (a UUID v4)
// is an active session.
exports.wrapCurrUser = function() {
  return function *(next) {
    var sessionId = this.cookies.get('session_id');
    debug('[wrapCurrUser] session_id: ' + sessionId);
    if (!sessionId) return yield next;
    var user = yield db.getUserBySessionId(sessionId);
    if (user) {
      this.currUser = pre.presentUser(user);
      this.currSessionId = sessionId;
      debug('[wrapCurrUser] User found');
    } else {
      debug('[wrapCurrUser] No user found');
    }
    yield* next;
  };
};

// Expose req.flash (getter) and res.flash = _ (setter)
// Flash data persists in user's sessions until the next ~successful response
exports.wrapFlash = function(cookieName) {
  cookieName = cookieName || 'flash';

  return function *(next) {
    var data, tmp;
    if (this.cookies.get(cookieName)) {
      tmp = decodeURIComponent(this.cookies.get(cookieName));
      // Handle bad JSON in the cookie, possibly set by fuzzers
      try {
        data = JSON.parse(tmp);
      } catch(err) {
        this.cookies.set(cookieName, null);
        data = {};
      }
    } else {
      data = {};
    }

    Object.defineProperty(this, 'flash', {
      enumerable: true,
      get: function() {
        return data;
      },
      set: function(val) {
        this.cookies.set(cookieName, encodeURIComponent(JSON.stringify(val)));
      }
    });

    yield* next;

    if (this.response.status < 300) {
      this.cookies.set(cookieName, null);
    }
  };
};

exports.methodOverride = function() {
  return function*(next) {
    if (_.isUndefined(this.request.body))
      throw new Error('methodOverride middleware must be applied after the body is parsed and this.request.body is populated');

    if (this.request.body && this.request.body._method) {
      this.method = this.request.body._method.toUpperCase();
      delete this.request.body._method;
    }

    yield* next;
  };
};

exports.removeTrailingSlash = function() {
  return function*(next) {
    if (this.path.length > 1 && this.path.endsWith('/')) {
      this.redirect(this.path.slice(0, this.path.length-1));
      return;
    }

    yield* next;
  };
};

exports.handleBouncerValidationError = function() {
  return function*(next) {
    try {
      yield* next;
    } catch(err) {
      if (err instanceof bouncer.ValidationError) {
        console.warn('Caught validation error:', err, err.stack);
        this.flash = {
          message: ['danger', err.message || 'Validation error'],
          params: this.request.body,
          bouncer: err.bouncer
        };
        this.redirect('back');
        return;
      }

      throw err;
    }
  };
};

exports.ensureRecaptcha = function*(next) {
  if (config.NODE_ENV === 'development' && !this.request.body['g-recaptcha-response']) {
    console.log('Development mode, so skipping recaptcha check');
    yield* next;
    return;
  }

  this.validateBody('g-recaptcha-response')
    .notEmpty('You must attempt the human test');

  try {
    yield recaptcha.promise(config.RECAPTCHA_SITESECRET, this.vals['g-recaptcha-response'], this.request.ip);
  } catch (err) {
    console.warn('Got invalid captcha: ', this.vals['g-recaptcha-response'], err);
    this.validateBody('g-recaptcha-response')
      .check(false, 'Could not verify recaptcha was correct');
    return;
  }

  yield* next;
};

// Cheap but simple way to protect against CSRF attacks
// TODO: Replace with something more versatile
exports.ensureReferer = function() {
  return function*(next) {

    // Skip get requests
    if (_.contains(['GET', 'HEAD', 'OPTION'], this.method)) {
      yield* next;
      return;
    }

    // Skip in development mode if no HOSTNAME is set
    if (config.NODE_ENV === 'development' && !config.HOSTNAME) {
      debug('Skipping referer check in development since HOSTNAME not provided');
      yield* next;
      return;
    }

    var refererHostname = nodeUrl.parse(this.headers['referer'] || '').hostname;

    this.assert(config.HOSTNAME === refererHostname, 'Invalid referer', 403);

    yield* next;
  };
};
