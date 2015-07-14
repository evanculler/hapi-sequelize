'use strict';

var _ = require('lodash');
var joi = require('joi');

var internals = {};

internals.user = function() {

};

/**
 * Creates a joi schema for validating history options against a sequelize model
 * @param model
 * @return {{track: *, idAttr: *, modelName: *, tableName: *, user: *}}
 */
internals.optionsSchema = function(model) {
    return {
        // fields to track - defaults to all fields
        track: joi.array().includes(joi.string()).single().default(Object.keys(model.attributes)),

        // the id attribute of the source model
        idAttr: joi.string().default('id'),

        // the history model name (e.g. "OrderHistory")
        modelName: joi.string().default(model.name+'History'),

        // the history table name (e.g. "order_history")
        tableName: joi.string().default(model.tableName+'_history'),

        // a function to obtain the user responsible for the change. may return a promise
        user: joi.func().default(internals.user)
    };
};

/**
 * builds the sequelize model definition
 * @param model the sequelize model to track
 * @param {{}} options history options
 * @return {Model} the history model
 */
internals.createHistoryModel = function(model, options) {
    var sequelize = model.sequelize;
    var DataTypes = sequelize.Sequelize;

    var idAttr = model.attributes[options.idAttr];

    if (!idAttr) throw new Error('Invalid id attribute for model ' + model.name + ': ' + options.idAttr);

    // the fields to track
    var attrs = options.track.reduce(function (acc, field) {
        acc[field] = model.attributes[field];
        return acc;
    }, {
        _id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        _sourceId: { type: idAttr.type, allowNull: false, unique: 'naturalId' },
        _revision: { type: DataTypes.INTEGER, unique: 'naturalId' },
        _user: DataTypes.STRING,
        _date: DataTypes.DATE,
        _changes: DataTypes.ARRAY(DataTypes.STRING)
    });

    var instanceMethods = {
        revert: function () {
            var values = _.pick(this, options.track);

            return this.getSource()
                .then(function (source) {
                    return source.update(values);
                });
        }
    };

    // sequelize model options
    var modelOpts = {
        tableName: options.tableName,
        instanceMethods: instanceMethods,
        timestamps: false,
        indexes: [{ fields: ['_sourceId'] }] };

    return model.sequelize.define(options.modelName, attrs, modelOpts);
};

/**
 * Associates the history model to the source model
 * @param historyModel
 * @param sourceModel
 * @return {*}
 */
internals.associate = function(historyModel, sourceModel) {
    historyModel.belongsTo(sourceModel, { as: 'source', foreignKey: '_sourceId', onDelete: 'cascade' });
    return historyModel;
};

/**
 * Writes a history entry
 * @param historyModel the history sequelize model
 * @param sourceModel the source sequelize model
 * @param options model options
 * @param instance the sourceModel instance
 * @return {*}
 */
internals.writeHistory = function(historyModel, sourceModel, options, instance) {
    var P = historyModel.sequelize.Promise;

    return P.bind()
        .then(function () {
            return P.all([options.user(), historyModel.count({ where: { _sourceId: instance[options.idAttr] }})]);
        })
        .spread(function (user, revision) {
            var record = _(instance._previousDataValues)
                .pick(options.track)
                .merge({
                    _sourceId: instance[options.idAttr],
                    _date: new Date(),
                    _user: user,
                    _revision: revision+1,
                    _changes: instance.changed() || []
                })
                .value();

            return historyModel.create(record);
        });
};

/**
 * Registers hooks for tracking changes
 * @param historyModel the history sequelize model
 * @param sourceModel the source sequelize model
 * @param options history options
 * @return {*}
 */
internals.addHooks = function(historyModel, sourceModel, options) {
    sourceModel.afterUpdate(function(instance) {
        return internals.writeHistory(historyModel, sourceModel, options, instance)
    });

    return historyModel;
};

/**
 * the model plugin function
 * @param options
 * @return {Function}
 */
module.exports = function(options) {
    if (_.isArray(options)) options = { track: options };

    options = _.isPlainObject(options) ? options : { track: [].slice.call(arguments) };

    return function (model) {
        joi.validate(options, internals.optionsSchema(model), function (err, validated) {
            if (err) throw err;
            options = validated;
        });

        return internals.addHooks(internals.associate(internals.createHistoryModel(model, options), model), model, options);
    };
};