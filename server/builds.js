/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:builds'), fs = require('fs');

/** (constant) The number of most recent builds to keep in `builds.json`. */
var kKeepBuildsCount = 100;

/**
  * @class BuildsManager
  * @description Instatiates a new BuildsManager object.
  * @param {BuilderManager} builderManager The BuilderManager instance.
  */
module.exports = function (builderManager) {
	var builds, nextBuildId = 1, thisThis = this;
	if (!fs.existsSync('data/logs')) {
		fs.mkdirSync('data/logs');
		builds = {};
	} else {
		nextBuildId = JSON.parse(fs.readFileSync('data/nextBuildId.json'),
			{encoding: 'UTF-8'}).id;
		builds = JSON.parse(fs.readFileSync('data/builds.json'),
			{encoding: 'UTF-8'});
	}

	/**
	  * @private
	  * @memberof! BuildsManager.prototype
	  * @description Writes the current in-memory builds data to disk.
	  */
	this._writeBuilds = function () {
		fs.writeFile('data/nextBuildId.json', JSON.stringify({id: nextBuildId}));
		if (Object.keys(builds).length > kKeepBuildsCount) {
			var buildsArray = [];
			for (var i in builds) {
				buildsArray.push(builds[i]);
			}
			buildsArray.sort(function (a, b) {
				return (b.lastTime - a.lastTime);
			});
			for (var i = 0; i < (buildsArray.length - kKeepBuildsCount); i++) {
				fs.writeFile('data/logs/' + buildsArray[i].id + '.json',
					JSON.stringify(buildsArray[i]));
				delete builds[buildsArray[i].id];
			}
		}
		fs.writeFile('data/builds.json', JSON.stringify(builds));
	};
	this._writeBuilds();

	this._buildFinishedCallbacks = [];
	/**
	  * @public
	  * @memberof! BuildsManager.prototype
	  * @description Allows the caller to specify a callback that will be
	  *   called when a build finishes. The callback will be passed the build
	  *   object.
	  * @param {function} callback The callback to call when a build finishes.
	  */
	this.onBuildFinished = function (callback) {
		this._buildFinishedCallbacks.push(callback);
	};

	/**
	  * @private
	  * @memberof! BuildsManager.prototype
	  * @description Called after a build finishes. Performs general operations
	  *   that need to be performed no matter if the build failed or succeeded
	  *   (re-setting the builder's status to 'online' from 'busy', etc.).
	  * @param {string} builderName The name of the builder that this build was run on.
	  * @param {Object} build The object of the build that just finished.
	  */
	this._buildFinished = function (builderName, build) {
		builderManager.builders[builderName].status('online');
		build.startTime = build.lastTime;
		build.lastTime = new Date();
		this._writeBuilds();
		for (var i in thisThis._buildFinishedCallbacks)
			thisThis._buildFinishedCallbacks[i](build);
		this._tryRunBuilds();
	};
	/**
	  * @private
	  * @memberof! BuildsManager.prototype
	  * @description Runs the specified build on the specified builder.
	  * @param {string} builderName The name of the builder run the build on.
	  * @param {Object} build The object of the build to run.
	  */
	this._runBuildOn = function (builderName, build) {
		log('starting build #%d...', build.id);
		build.status = 'running';
		build.lastTime = new Date();
		build.builder = builderName;
		var builder = builderManager.builders[builderName];

		build.curStep = 0;
		function commandFinished(exitcode, output) {
			var step = build.steps[build.curStep];
			step.exitcode = exitcode;
			step.output = output.trim();
			if (!build.handleResult(step.command, exitcode, output)) {
				build.status = 'failed';
				thisThis._buildFinished(builderName, build);
				log('build #%d failed on step %d', build.id, build.curStep);
				return;
			}

			build.curStep++;
			if (build.curStep == build.steps.length) {
				if (build.onSuccess != undefined)
					build.onSuccess();
				delete build.curStep;
				build.status = 'succeeded';
				thisThis._buildFinished(builderName, build);
				log('build #%d succeeded!', build.id);
				return;
			}
			builder.runCommand(build.steps[build.curStep].command, commandFinished);
		}
		builder.runCommand(build.steps[build.curStep].command, commandFinished);
	};
	/**
	  * @private
	  * @memberof! BuildsManager.prototype
	  * @description Looks for available builders to run all pending builds on.
	  */
	this._tryRunBuilds = function () {
		var availableBuilders = [];
		for (var builderName in builderManager.builders) {
			if (builderManager.builders[builderName].status() == 'online')
				availableBuilders.push(builderName);
		}

		for (var i in builds) {
			if (availableBuilders.length == 0)
				return;
			if (builds[i].status != 'pending')
				continue;
			if (builds[i].architecture == 'any') {
				this._runBuildOn(availableBuilders[0], builds[i]);
				builderManager.builders[builderName].status('busy');
				delete availableBuilders[0];
			}
		}
	};

	/**
	  * @public
	  * @memberof! BuildsManager.prototype
	  * @description Adds the specified build to the list of pending
	  *   builds.
	  * @param {Object} build The object of the build to add.
	  */
	this.addBuild = function (build) {
		build.id = nextBuildId++;
		this._writeBuilds();

		build.status = 'pending';
		builds[build.id] = build;
		log("build #%d ('%s') created", build.id, build.description);
		this._tryRunBuilds();
	};
	/**
	  * @public
	  * @memberof! BuildsManager.prototype
	  * @description Summarizes the current list of builds in a format
	  *   fit for client (webapp) consumption.
	  * @returns {Object} The created summary of current builds.
	  */
	this.buildsSummary = function () {
		var ret = [];
		for (var i in builds) {
			var build = builds[i];
			ret.push({
				id: build.id,
				status: build.status,
				description: build.description,
				lastTime: build.lastTime,
				steps: build.steps.length
			});
		}
		ret.sort(function (a, b) {
			return (b.id - a.id);
		});
		return ret;
	};
	/**
	  * @public
	  * @memberof! BuildsManager.prototype
	  * @description Returns the full list of in-memory builds, including
	  *   steps, console output, and status.
	  * @returns {Object} The `builds` object.
	  */
	this.builds = function () {
		return builds;
	};

	builderManager.onBuilderConnected(function (name) {
		thisThis._tryRunBuilds();
	});
};
