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

/*! This manages the HaikuPorts tree that Kitchen uses. */

if (!shell.which('git')) {
	log('FATAL: git must be installed.');
	process.exit(2);
}

module.exports = function () {
	// Having these functions be inline instead of in a prototype consumes more
	// RAM, but since there should only be one instance of this object anyway
	// it shouldn't be an issue.

	this._updateClientCache = function () {
		var newClientRecipes = [];
		for (var i in this.recipes) {
			newClientRecipes.push({
				name: this.recipes[i].name,
				category: this.recipes[i].category,
				version: this.recipes[i].version,
				revision: this.recipes[i].revision,
				lint: '?'
			});
		}
		var thisThis = this;
		zlib.gzip(JSON.stringify(newClientRecipes), {level: 9}, function (err, res) {
			thisThis.clientRecipes = res;
		});
	};
	this._updateCacheFor = function (files) {
		log('updating %d entries...', files.length);
		for (var i in files) {
			var recipe = new Recipe(files[i]);
			this.recipes[recipe.name + '-' + recipe.version] = recipe;
		}
		this._updateClientCache();
		log('recipe metadata update complete.');
	};
	this._completeCacheRebuild = function () {
		this.recipes = {};
		this._updateCacheFor(glob.sync('cache/haikuports/*-*/*/*.recipe'));
	};

	this._createCache = function () {
		log('creating cache from scratch...');
		shell.rm('-rf', 'cache');
		shell.mkdir('cache');
		shell.cd('cache');
			log('cloning haikuports...');
			var res = shell.exec('git clone --depth=1 https://bitbucket.org/haikuports/haikuports.git',
				{silent: true});
			if (res.code !== 0) {
				log('FATAL: clone failed: %s', res.output);
				process.exit(3);
			}
		shell.cd('..');
		this._completeCacheRebuild();
	};
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
		this._HEAD = shell.exec('git rev-parse HEAD', {silent: true})
				.output.trim();
		this._writeCache();
		log('cache created successfully.');
	}

	this.update = function () {
		var thisThis = this;
		log('running git-pull...');
		shell.cd('cache/haikuports');
			shell.exec('git pull --ff-only', {silent: true}, function (code, output) {
				if (code) {
					log('git-pull failed: ' + output);
					log('recreating cache...');
					thisThis._createCache();
				} else if (output.indexOf('Already up-to-date.') >= 0) {
					log('git-pull finished, no changes');
				} else {
					log('git-pull finished, doing incremental cache update...');
					shell.cd('cache/haikuports');
						var cmd = 'git diff ' + thisThis._HEAD + '..HEAD --numstat';
						shell.exec(cmd, {silent: true}, function (code, output) {
							output = output.split(/\r*\n/);
							var filesToUpdate = [], deletedEntries = 0;
							for (var i in output) {
								line = output[i].split('\t');
								if (line.length != 3)
									continue;
								// 0 is additions, 1 is deletions, 2 is filename
								if (!/\.recipe$/.test(line[2]))
									continue;
								if (line[1] == 0) {
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
										thisThis._createCache();
										return;
									}
								} else {
									// still exists, we're good
									filesToUpdate.push('cache/haikuports/' + line[2]);
								}
							}
							log('deleted %d entries from the cache', deleted);
							thisThis._updateCacheFor(filesToUpdate);

							thisThis._HEAD = shell.exec('git rev-parse HEAD', {silent: true})
								.output.trim();
							thisThis._writeCache();
						});
					shell.cd('../..');
				}
			});
		shell.cd('../..');
	};
};
