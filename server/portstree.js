/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:portstree'), fs = require('fs'),
	shell = require('shelljs'), zlib = require('zlib'), glob = require('glob'),
	Recipe = require('./recipe.js');

if (!shell.which('git')) {
	console.error('FATAL: git must be installed.');
	process.exit(1);
}

/**
  * @class PortsTree
  * @description Instatiates a new PortsTree object.
  *
  * There should only be one instance of PortsTree running on one
  * machine at any given time, as it assumes complete control of a
  * ports tree stored in `cache/haikuports`.
  *
  * PortsTree does not schedule any tasks, it leaves that up to the
  * caller to do. Certain functions inside this object are static
  * and thus can be connected to timer events.
  */
module.exports = function () {
	var thisThis = this;

	/**
	  * @private
	  * @memberof! PortsTree.prototype
	  * @description Updates the "client cache".
	  *
	  * {@link Recipe} objects load and store more data than the web
	  * app (and whatever other consumers) need access to, and accessing
	  * the list on each request would be too cycle-costly, so instead,
	  * a gzip-compressed in-memory cache is kept of this information.
	  */
	this._updateClientCache = function () {
		var newClientRecipes = [];
		for (var i in this.recipes) {
			var recipe = this.recipes[i];
			newClientRecipes.push({
				name: recipe.name,
				category: recipe.category,
				version: recipe.version,
				revision: recipe.revision,
				lint: recipe.lint
			});
		}
		newClientRecipes.sort(function (a, b) {
			if (a.category == b.category)
				return (a.name > b.name) - (a.name < b.name);
			else
				return (a.category > b.category) - (a.category < b.category);
		});
		zlib.gzip(JSON.stringify(newClientRecipes), function (err, res) {
			thisThis.clientRecipes = res;
		});
	};
	/**
	  * @private
	  * @memberof! PortsTree.prototype
	  * @description Updates the in-memory cache for the specified **files**
	  *   (not recipes!).
	  *
	  *   This function will create new {@link Recipe} objects and replace the
	  *   old ones with them for the specified files. It will also call
	  *   {@link PortsTree#_updateClientCache}.
	  * @param {array} files The list of files to update.
	  */
	this._updateCacheFor = function (files) {
		log('updating %d entries...', files.length);
		for (var i in files) {
			var recipe = new Recipe(files[i]);
			this.recipes[recipe.name + '-' + recipe.version] = recipe;
		}
		this._updateClientCache();
		log('recipe metadata update complete.');
	};
	/**
	  * @private
	  * @memberof! PortsTree.prototype
	  * @description Updates the value of `this._HEAD` (the SHA1 of the current
	  *   HaikuPorts commit).
	  */
	this._updateHEAD = function () {
		this._HEAD = shell.exec('cd cache/haikuports && git rev-parse HEAD', {silent: true})
				.output.trim();
	};
	/**
	  * @private
	  * @memberof! PortsTree.prototype
	  * @description Scraps the in-memory caches and rebuilds them using the
	  *   current HaikuPorts tree.
	  */
	this._completeCacheRebuild = function () {
		this.recipes = {};
		this._updateCacheFor(glob.sync('cache/haikuports/*-*/*/*.recipe'));
		this._updateHEAD();
		this._writeCache();
	};

	/**
	  * @private
	  * @memberof! PortsTree.prototype
	  * @description Deletes the on-disk *and* in-memory caches and recreates
	  *   them from scratch.
	  */
	this._createCache = function () {
		log('creating cache from scratch...');
		shell.rm('-rf', 'cache');
		shell.mkdir('cache');
		log('cloning haikuports...');
		var cmd = 'cd cache && git clone --depth=1 https://github.com/haikuports/haikuports.git';
		var res = shell.exec(cmd, {silent: true});
		if (res.code !== 0) {
			log('FATAL: clone failed: %s', res.output);
			process.exit(3);
		}
		this._completeCacheRebuild();
		for (var i in thisThis._pullFinishedCallbacks)
			thisThis._pullFinishedCallbacks[i]();
	};
	/**
	  * @private
	  * @memberof! PortsTree.prototype
	  * @description Saves the in-memory recipe cache (**NOT** the in-memory
	  *   client/web cache) and `this._HEAD` to disk in JSON format.
	  */
	this._writeCache = function () {
		var recipesStr = JSON.stringify(this.recipes);
		var headStr = JSON.stringify(this._HEAD);
		fs.writeFile('cache/recipes.json', recipesStr, function (err) {
			if (err) {
				log('WARN: cache could not be written to disk: ', err);
				return;
			}
			fs.writeFile('cache/recipes-HEAD.json', headStr, function (err) {
				if (err) {
					log('WARN: cache-HEAD could not be written to disk: ', err);
					return;
				}
				log('saved cache to disk successfully.');
			});
		});
	};

	if (fs.existsSync('cache/recipes.json') &&
		fs.existsSync('cache/recipes-HEAD.json')) {
		log('cache exists on disk, loading...');
		this.recipes = JSON.parse(fs.readFileSync('cache/recipes.json',
			{encoding: 'UTF-8'}));
		this._HEAD = JSON.parse(fs.readFileSync('cache/recipes-HEAD.json',
			{encoding: 'UTF-8'}));
		this._updateClientCache();
		log('finished loading the cache.');
	} else {
		log('no cache on disk, creating it...');
		if (!fs.existsSync('cache/haikuports/'))
			this._createCache();
		else
			this._completeCacheRebuild();
		this._writeCache();
		log('cache created successfully.');
	}

	this._pullFinishedCallbacks = [];
	/**
	  * @public
	  * @memberof! PortsTree.prototype
	  * @description Allows the caller to specify a callback that will be
	  *   called after "git pull" is run in the tree.
	  * @param {function} callback The callback to call when the tree changes.
	  */
	this.onPullFinished = function (callback) {
		this._pullFinishedCallbacks.push(callback);
	};

	/**
	  * @public
	  * @memberof! PortsTree
	  * @description Runs `git pull` to check for changes in the HaikuPorts
	  *   tree, performing any cache updates or rebuilds needed.
	  *
	  * When the `git pull` command exits, it checks the output and exitcode
	  * to see if it failed or succedeed. If it failed, it assumes something
	  * in the tree is corrupt, deletes the cache and rebuilds it (via
	  * `_createCache`). If it succeeded but it finds "Already up-to-date."
	  * in the output, then it assumes the cache does not need to be updated
	  * and exits early. Otherwise, it runs `git diff <oldhead>..HEAD --numstat`
	  * to get a machine-friendly diffstat of the differences before and after
	  * the pull, and attempts to use this to perform an incremental cache
	  * update. If the incremental update fails for some reason, it deletes
	  * and recreates the cache.
	  */
	this.update = function () {
		if (!fs.existsSync('cache/recipes.json'))
			return thisThis._createCache();

		log('running git-pull...');
		shell.exec('cd cache/haikuports && git pull --ff-only', {silent: true}, function (code, output) {
			if (code) {
				log('git-pull failed: ' + output);
				if (output.indexOf('Failed to connect') >= 0 ||
					output.indexOf('Could not resolve host') >= 0)
					return;
				log('recreating cache...');
				thisThis._createCache();
			} else if (output.indexOf('Already up-to-date.') >= 0) {
				log('git-pull finished, no changes');
				for (var i in thisThis._pullFinishedCallbacks)
					thisThis._pullFinishedCallbacks[i]();
			} else {
				log('git-pull finished, doing incremental cache update...');
				var cmd = 'cd cache/haikuports && git diff ' + thisThis._HEAD + '..HEAD --numstat';
				shell.exec(cmd, {silent: true}, function (code, output) {
					if (code !== 0) {
						log("git-diff did not exit with 0: '%s', performing " +
							'complete cache rebuild', output.trim());
						thisThis._completeCacheRebuild();
						return;
					}
					output = output.split(/\r*\n/);
					var filesToUpdate = [], deletedEntries = 0;
					for (var i in output) {
						line = output[i].split('\t');
						if (line.length != 3)
							continue;
						// 0 is additions, 1 is deletions, 2 is filename
						if (!/\.recipe$/.test(line[2]))
							continue;
						if (line[1] === 0) {
							// only additions, just add the file to the list
							filesToUpdate.push('cache/haikuports/' + line[2]);
							continue;
						}
						// There are some deletions in this file, so
						// make sure it exists.
						if (!fs.existsSync('cache/haikuports/' + line[2])) {
							// doesn't exist, attempt to delete it from cache
							var splitPath = line[2].split('/');
							var name = splitPath[splitPath.length - 1].replace('.recipe', '');
							if (name in thisThis.recipes) {
								delete thisThis.recipes[name];
								deletedEntries++;
							} else {
								// that file doesn't exist in the cache
								log('incremental cache update failed, ' +
									'doing full cache update instead');
								thisThis._completeCacheRebuild();
								return;
							}
						} else {
							// still exists, we're good
							filesToUpdate.push('cache/haikuports/' + line[2]);
						}
					}
					log('deleted %d entries from the cache', deletedEntries);
					thisThis._updateCacheFor(filesToUpdate);

					var changedRecipes = [];
					for (var i in filesToUpdate) {
						var r = /[^/]*$/.exec(filesToUpdate[i])[0].replace('.recipe', '');
						changedRecipes.push(r);
						delete thisThis.recipes[r].lint;
					}
					for (var i in thisThis._pullFinishedCallbacks)
						thisThis._pullFinishedCallbacks[i]();
					thisThis._updateHEAD();
					thisThis._writeCache();
				});
			}
		});
	};
};
