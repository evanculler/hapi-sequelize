'use strict';

const _ = require('lodash');
const boom = require('boom');
const joi = require('joi');
const Sequelize = require('sequelize');
const lookupHandler = require('./lookup-handler');
const queryHandler = require('./query-handler');
const removeHandler = require('./remove-handler');
const updateHandler = require('./update-handler');

exports.associate = function associate (sequelize) {
    _.forEach(sequelize.models, function (model) {
        if ('associate' in model.options) {
            model.options.associate.call(model, sequelize.models);
        }
    });
};

exports.enablePlugins = function () {
    Sequelize.Model.prototype.plugin = function (plugin) {
        plugin(this);
        return this;
    };
};

exports.bulkUpsert = require('./bulk-upsert-plugin');

exports.enableBulkUpsert = function () {
    _.assign(Sequelize.Model.prototype, exports.bulkUpsert.plugin);
};

exports.hasHooks = function (newInstance) {
    return function (Model) {
        Model.Instance.prototype.hooks = function hooks () {
            this._hooks = this._hooks || newInstance().curry(this);
            return this._hooks;
        };

        Model.Instance.prototype.runHook = function runHook (event) {
            return this.hooks().runHook.apply(this._hooks, arguments);
        };

        Model.Instance.prototype.on = function on (event, listener) {
            return this.hooks().on(event, listener);
        };
    };
};

exports.slug = require('./slug-plugin');

exports.history = require('./history-plugin');

/**
 *
 * @param sequelize
 * @param fn
 * @return {*}
 */
exports.requiresTransaction = function (sequelize, fn) {
    const t = Sequelize.cls && Sequelize.cls.get('transaction');
    const P = Sequelize.Promise;

    // make sure not to throw synchronous errors
    if (t) return P.try(() => fn(t));

    return sequelize.transaction(fn);
};

exports.enableRequiresTransaction = function () {
    Sequelize.prototype.requiresTransaction = function (fn) {
        return exports.requiresTransaction(this, fn);
    };
};

exports.restoreDefaultsPlugin = require('./restore-defaults-plugin').restoreDefaultsPlugin;

exports.enableLobSupport = function () {
    _.assign(Sequelize.prototype, require('./lob-plugin'));
};

exports.tableLog = require('./etag-plugin');

exports.register = function (server, opts, next) {
    let sequelize, models;
    const schema = {
        database: joi.string().required(),
        user: joi.string().required(),
        password: joi.string().default(''),
        options: joi.object().keys({
            dialect: joi.string().default('postgres'),
            host: joi.string(),
            port: joi.number().integer(),
            sync: joi.any(),
            pool: joi.object(),
            logging: joi.alternatives([joi.boolean(), joi.func()]).default(_.constant(server.log.bind(server, ['db', 'debug'])), 'default logger')
        }).default({ dialect: 'postgres' }),
        namespace: joi.string().optional(),
        appVar: joi.string().default('db'),
        auth: joi.any().default(false),
        transaction: {
            isolationLevel: 'READ_COMMITTED' // READ_COMMITTED, REPEATABLE_READ, OR SELIAZABLE
        },
        queryHandler: {
            limit: joi.number().integer().default(30)
        },
        sync: joi.boolean().default(false)
    };

    joi.validate(opts, schema, function (err, validated) {
        if (err) return next(err);

        opts = validated;
    });

    if (opts.namespace && process.namespaces && process.namespaces[opts.namespace]) {
        server.ext('onPreStart', function (server, next) {
            Sequelize.cls = process.namespaces[opts.namespace];
            next();
        });
    }

    // turn on plugin support
    exports.enablePlugins();

    // turn on bulk upsert
    exports.enableBulkUpsert();

    // adds requiresTransaction() method to sequelize
    exports.enableRequiresTransaction();

    // turn on lobs
    exports.enableLobSupport();

    sequelize = new Sequelize(opts.database,
        opts.user,
        opts.password,
        opts.options);

    models = sequelize.models;

    const api = server.app[opts.appVar] = {
        models: models,
        model: function (modelName) {
            if (!models.hasOwnProperty(modelName)) throw new Error('No such model: ' + modelName);

            return models[modelName];
        },
        sequelize: sequelize,
        define: function (defineFn) {
            return defineFn(sequelize);
        },
        query: sequelize.query.bind(sequelize)
    };

    server.expose(api);
    server.ext('onPreStart', function (server, done) {
        server.log(['ent-sequelize', 'log'], 'Associating models');
        exports.associate(sequelize);
        if (opts.sync) {
            server.log(['ent-sequelize', 'log'], 'Syncing database schema...');
            return sequelize.sync().nodeify(done);
        } else {
            done();
        }
    });

    server.ext('onPreHandler', function (req, reply) {
        const seqConfig = req.route.settings.plugins.sequelize;
        if (seqConfig && seqConfig.transaction) {
            //joi.assert(seqConfig.transaction, {
            //    isolationLevel: [joi.boolean(), joi.string().valid(['READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE'])]
            //});
            //
            //const transactionOpts = _.isBoolean(seqConfig.transaction) ? opts.transaction : seqConfig.transaction;

            req.log(['sequelize', 'debug'], 'Starting transaction');

            sequelize.transaction()
                .then(function (t) {
                    req.plugins.sequelize = req.plugins.sequelize || {};
                    req.plugins.sequelize.transaction = t;
                    reply.continue();
                })
                .catch(reply);
        } else {
            reply.continue();
        }
    });

    server.ext('onPostHandler', function (req, reply) {
        const t = req.plugins.sequelize && req.plugins.sequelize.transaction;

        if (!t || t.finished) return reply.continue();

        if (req.response instanceof Error) {
            req.log(['sequelize', 'info'], 'Rolling back transaction');
            t.rollback().then(() => reply.continue());
        } else {
            req.log(['sequelize', 'info'], 'Committing transaction');
            t.commit().then(() => reply.continue());
        }
    });

    server.ext('onPostHandler', function (req, reply) {
        if (req.response instanceof sequelize.ValidationError) {
            const error = boom.badRequest(req.response);
            error.output.payload.validation = req.response.errors;
            return reply(error);
        }
        reply.continue();
    });

    server.decorate('request', 'model', api.model);
    server.handler('db.query', queryHandler(sequelize, opts.queryHandler));
    server.handler('db.lookup', lookupHandler(sequelize));
    server.handler('db.remove', removeHandler(sequelize, opts.deleteHandler));
    server.handler('db.update', updateHandler(sequelize));
    server.handler('db.upsert', function (route, options) {
        return updateHandler(sequelize, route, _.assign(options, { create: true }));
    });
    next();
};

exports.Sequelize = Sequelize;

exports.register.attributes = { pkg: require('../package.json') };