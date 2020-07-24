const Sequelize = require('sequelize');
const clsHook = require('cls-hooked');
let CLS_CONTEXT_NAMESPACE;

function capitalize(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function stringify(value) {
  return JSON.stringify(value);
}

const VersionType = {
  CREATED: 1,
  UPDATED: 2,
  DELETED: 3,
};

const Hook = {
  AFTER_CREATE: 'afterCreate',
  AFTER_UPDATE: 'afterUpdate',
  AFTER_DESTROY: 'afterDestroy',
  AFTER_SAVE: 'afterSave',
  AFTER_BULK_CREATE: 'afterBulkCreate',
  AFTER_BULK_UPDATE: 'afterBulkUpdate',
  BEFORE_BULK_UPDATE: 'beforeBulkUpdate',
  BEFORE_BULK_CREATE: 'beforeBulkCreate',
};

const defaults = {
  prefix: 'version',
  attributePrefix: '',
  suffix: '',
  schema: '',
  sequelize: null,
  exclude: [],
  tableUnderscored: true,
  underscored: true,
  versionAttributes: null,
};

function isEmpty(string) {
  return [undefined, null, NaN, ''].indexOf(string) > -1;
}

const hooks = [Hook.AFTER_CREATE, Hook.AFTER_UPDATE, Hook.AFTER_DESTROY];

const beforeBulkHooks = [Hook.BEFORE_BULK_UPDATE, Hook.BEFORE_BULK_CREATE];

function getVersionType(hook) {
  switch (hook) {
  case Hook.AFTER_CREATE:
  case Hook.AFTER_BULK_CREATE:
    return VersionType.CREATED;
  case Hook.AFTER_UPDATE:
  case Hook.AFTER_BULK_UPDATE:
    return VersionType.UPDATED;
  case Hook.AFTER_DESTROY:
    return VersionType.DELETED;
  }
  throw new Error('Version type not found for hook ' + hook);
}

function Version(model, customOptions) {
  // Context Namespace not found - Context namespace is mandatory
  if (!CLS_CONTEXT_NAMESPACE) {
    throw new Error('sequelize-version: Context namespace should be ');
  }

  const options = Object.assign({}, defaults, Version.defaults, customOptions);

  const { prefix, suffix, tableUnderscored, underscored } = options;

  if (isEmpty(prefix) && isEmpty(suffix)) {
    throw new Error('Prefix or suffix must be informed in options.');
  }

  const sequelize = options.sequelize || model.sequelize;
  const schema = options.schema || model.options.schema;
  const attributePrefix = options.attributePrefix || options.prefix;
  const tableName = `${
    prefix ? `${prefix}${tableUnderscored ? '_' : ''}` : ''
  }${model.options.tableName || model.name}${
    suffix ? `${tableUnderscored ? '_' : ''}${suffix}` : ''
  }`;
  const versionFieldType = `${attributePrefix}${underscored ? '_t' : 'T'}ype`;
  const versionFieldId = `${attributePrefix}${underscored ? '_i' : 'I'}d`;
  const versionFieldTimestamp = `${attributePrefix}${
    underscored ? '_t' : 'T'
  }imestamp`;
  const versionModelName = `${capitalize(prefix)}${capitalize(model.name)}`;
  const jsonData = 'json_data';
  const entityId = 'entity_id';
  const changeBy = 'change_by';

  const versionAttrs = {
    [entityId]: {
      type: Sequelize.INTEGER,
      allowNull: true,
    },
    [versionFieldId]: {
      type: Sequelize.BIGINT,
      primaryKey: true,
      autoIncrement: true,
    },
    [versionFieldType]: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    [versionFieldTimestamp]: {
      type: Sequelize.DATE,
      allowNull: false,
    },
    [jsonData]: {
      type: Sequelize.JSON,
      allowNull: true,
    },
    [changeBy]: {
      type: Sequelize.JSON,
      allowNull: true,
    },
  };

  const versionModelAttrs = Object.assign({}, versionAttrs);

  const versionModelOptions = {
    tableName,
    timestamps: false,
    indexes: [
      {
        key: true,
        fields: ['entity_id'],
        name: `${tableName}_entity_id`,
      },
    ],
  };

  const versionModel = sequelize.define(
    versionModelName,
    versionModelAttrs,
    versionModelOptions
  );

  // creates version model if it doesn't already exists
  versionModel.sync();

  beforeBulkHooks.forEach(function(bulkHook) {
    model.addHook(bulkHook, function(options) {
      options.individualHooks = true;
    });
  });

  hooks.forEach(hook => {
    model.addHook(hook, instanceData => {
      return new Promise(async resolve => {
        resolve();
        try {
          const clsNamespace = clsHook.getNamespace(CLS_CONTEXT_NAMESPACE);

          const versionType = getVersionType(hook);
          const instancesData = toArray(instanceData);
          const changeByData = clsNamespace.get('change_by') || null;
          const versionData = instancesData.map(data => {
            const idVal = data.id ? data.id : null;
            return Object.assign(
              {},
              {
                [versionFieldType]: versionType,
                [versionFieldTimestamp]: new Date(),
                [jsonData]: data,
                [entityId]: idVal,
                [changeBy]: changeByData,
              }
            );
          });
          await versionModel.bulkCreate(versionData);
        } catch (err) {
          console.error(
            'Sequelize-Version: Error while updating version model',
            err
          );
        }
      });
    });
  });

  versionModel.addScope('created', {
    where: { [versionFieldType]: VersionType.CREATED },
  });

  versionModel.addScope('updated', {
    where: { [versionFieldType]: VersionType.UPDATED },
  });

  versionModel.addScope('deleted', {
    where: { [versionFieldType]: VersionType.DELETED },
  });

  function getVersions(params) {
    let versionParams = {};
    const modelAttributes = model.rawAttributes || model.attributes;
    const primaryKeys = Object.keys(modelAttributes).filter(
      attr => modelAttributes[attr].primaryKey
    );

    if (primaryKeys.length) {
      versionParams.where = primaryKeys
        .map(attr => ({ [attr]: this[attr] }))
        .reduce((a, b) => Object.assign({}, a, b));
    }

    if (params) {
      if (params.where)
        versionParams.where = Object.assign(
          {},
          params.where,
          versionParams.where
        );
      versionParams = Object.assign({}, params, versionParams);
    }

    return versionModel.findAll(versionParams);
  }

  // Sequelize V4 and above
  if (model.prototype) {
    if (!model.prototype.hasOwnProperty('getVersions')) {
      model.prototype.getVersions = getVersions;
    }

    //Sequelize V3 and below
  } else {
    const hooksForBind = hooks.concat([Hook.AFTER_SAVE]);

    hooksForBind.forEach(hook => {
      model.addHook(hook, instance => {
        const instances = toArray(instance);
        instances.forEach(i => {
          if (!i.getVersions) i.getVersions = getVersions;
        });
      });
    });
  }

  if (!model.getVersions) {
    model.getVersions = params => versionModel.findAll(params);
  }

  return versionModel;
}

Version.defaults = Object.assign({}, defaults);
Version.VersionType = VersionType;

const setContextNamespace = _contextNamespace => {
  CLS_CONTEXT_NAMESPACE = _contextNamespace;
};

module.exports = {
  Version,
  setContextNamespace,
};
