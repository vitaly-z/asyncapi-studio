const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { logLineWithBlock, logSuccessLine, logErrorLine, logErrorLineWithLongMessage } = require('./lib/logger');
const pipeline = require('./lib/pipeline');
const events = require('./lib/events');
const { plugins } = require('../config/plugins.json');

const readFile = promisify(fs.readFile);
const symLink = promisify(fs.symlink);
const mkdir = promisify(fs.mkdir);

const ROUTES_PIPELINE_NAME = '__server:routes__';
const AUTH_ROUTES_PIPELINE_NAME = '__server:routes:authenticated__';
const MW_PIPELINE_NAME = '__server:middlewares__';
const AUTH_MW_PIPELINE_NAME = '__server:middlewares:authenticated__';
const FORBIDDEN_HOOKS = [ROUTES_PIPELINE_NAME, AUTH_ROUTES_PIPELINE_NAME, MW_PIPELINE_NAME, AUTH_MW_PIPELINE_NAME];

(async function () {
  for (let pluginPath of plugins) {
    let absolutePluginPath;

    if (pluginPath.startsWith(`.${path.sep}`)) {
      absolutePluginPath = path.resolve(__dirname, '..', pluginPath);
    } else {
      absolutePluginPath = path.resolve(__dirname, '..', 'node_modules', pluginPath);
    }

    let packageJSON = await readFile(path.resolve(absolutePluginPath, 'package.json'));
    packageJSON = JSON.parse(packageJSON);

    const { name, version } = packageJSON;

    logLineWithBlock('PLUGIN', `${name}@${version}`, 'Registering plugin...');

    registerHooks(packageJSON);
    registerMiddlewares(packageJSON);
    registerEvents(packageJSON);
    await registerPages(packageJSON, absolutePluginPath);
  }
})();

function registerHooks(packageJSON) {
  const { asyncapihub, name: pluginName } = packageJSON;

  if (asyncapihub.hooks) {
    const hookPoints = Object.keys(asyncapihub.hooks).filter(hookName => !FORBIDDEN_HOOKS.includes(hookName));
    hookPoints.forEach(hookPoint => {
      const hookTargetPaths = asyncapihub.hooks[hookPoint];
      hookTargetPaths.forEach(hookTargetPath => {
        try {
          const hookTarget = require(path.join(pluginName, hookTargetPath));
          pipeline.append(hookPoint, hookTarget);

          logSuccessLine(`Hook ${hookPoint} ${hookTargetPath}`, { highlightedWords: [hookPoint] });
        } catch (e) {
          logErrorLine(`Hook ${hookPoint} ${hookTargetPath}`, { highlightedWords: [hookPoint] });
        }
      });
    });
  }
}

function registerEvents(packageJSON) {
  const { asyncapihub, name: pluginName } = packageJSON;

  if (asyncapihub.events) {
    Object.keys(asyncapihub.events).forEach(eventName => {
      const eventTargetPaths = asyncapihub.events[eventName];
      eventTargetPaths.forEach(eventTargetPath => {
        try {
          const eventHandler = require(path.join(pluginName, eventTargetPath));
          events.on(eventName, eventHandler);

          logSuccessLine(`Event ${eventName} ${eventTargetPath}`, { highlightedWords: [eventName] });
        } catch (e) {
          logErrorLineWithLongMessage(`Event ${eventName} ${eventTargetPath}`, e.message, { highlightedWords: [eventName] });
        }
      });
    });
  }
}

function registerMiddlewares(packageJSON) {
  const { asyncapihub, name: pluginName } = packageJSON;

  if (asyncapihub.middlewares) {
    asyncapihub.middlewares.forEach(middlewareObject => {
      let middlewarePath;

      try {
        middlewarePath = middlewareObject.path;
        const needsAuth = !!middlewareObject.session;
        const middleware = require(path.join(pluginName, middlewarePath));
        pipeline.append(`__server:middlewares${needsAuth ? ':authenticated' : ''}__`, middleware);

        logSuccessLine(`Middleware ${middlewarePath} ${needsAuth ? 'requires' : 'does not require' } authentication`, { highlightedWords: [middlewarePath] });
      } catch (e) {
        logErrorLineWithLongMessage(`Hook ${middlewarePath}`, e.message, { highlightedWords: [middlewarePath] });
      }
    });
  }
}

async function registerPages(packageJSON, absolutePluginPath) {
  const { asyncapihub, name: pluginName } = packageJSON;

  if (asyncapihub.pages) {
    const pagePaths = Object.keys(asyncapihub.pages);
    await Promise.all(pagePaths.map(async (pagePath) => {
      const pageDefinition = asyncapihub.pages[pagePath];
      const linkTarget = path.resolve(absolutePluginPath, pageDefinition.pagePath);
      const linkPath = path.resolve(__dirname, 'pages/_plugins/', pagePath.startsWith('/') ? pagePath.substr(1) : pagePath);
      const relativeTargetPath = path.relative(path.resolve(__dirname, '..'), linkTarget);

      try {
        await mkdir(path.dirname(linkPath), { recursive: true });
      } catch (e) {
        logErrorLineWithLongMessage(`Page ${pagePath}`, e.message, { highlightedWords: [pagePath] });
        return;
      }

      try {
        await symLink(linkTarget, linkPath.endsWith('.js') ? linkPath : `${linkPath}.js`);
      } catch (e) {
        if (e.code !== 'EEXIST') {
          logErrorLineWithLongMessage(`Page ${pagePath}`, e.message, { highlightedWords: [pagePath] });
          return;
        }
      }

      try {
        const routeHandlerPath = require(path.join(pluginName, pageDefinition.routeHandlerPath));
        pipeline.append(`__server:routes${pageDefinition.session ? ':authenticated' : ''}__`, routeHandlerPath, { urlPath: pagePath, pluginName });
      } catch (e) {
        logErrorLineWithLongMessage(`Page ${pagePath}`, e.message, { highlightedWords: [pagePath] });
        return;
      }

      logSuccessLine(`Page ${pagePath} ${relativeTargetPath}`, { highlightedWords: [pagePath] });
    }));
  }
}
