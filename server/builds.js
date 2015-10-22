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
		try {
			nextBuildId = JSON.parse(fs.readFileSync('data/nextBuildId.json'),
				{encoding: 'UTF-8'}).id;
			builds = JSON.parse(fs.readFileSync('data/builds.json'),
				{encoding: 'UTF-8'});
		} catch (e) {
			nextBuildId = 1;
			builds = {};
		}
		// Remove all pending builds, as we can't use them because they don't
		// have the callbacks in them
		for (var i in builds) {
			if (builds[i].status == 'pending')
				delete builds[i];
		}
		// Reset nextBuildId
		var highestBuildId = 1;
		for (var i in builds) {
			if (builds[i].id > highestBuildId)
				highestBuildId = builds[i].id;
		}
		if (highestBuildId != 1)
			nextBuildId = highestBuildId + 1;
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
		if (builderManager.builders[builderName].status() == 'busy')
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
		build.builderName = builderName;
		build.stepsSucceeded = 0;
		build.nextStep = 0;
		var builder = builderManager.builders[builderName];
		if (builder === undefined) {
			build.status = 'failed';
			return;
		}

		var nextCommand;
		function commandFinished(exitcode, output) {
			if (exitcode == 999999999 && output == 'Builder disconnected') {
				build.status = 'failed';
				log('build #%d failed because the builder disconnected', build.id);
				thisThis._buildFinished(builderName, build);
				return;
			}

			var step = build.steps[build.nextStep];
			step.exitcode = exitcode;
			step.output = output.trim();
			var res;
			try {
				res = build.handleResult(step, exitcode, output)
			} catch (e) {
				log('handleResult() failed (build #%d):', build.id);
				log(e);
				res = false;
			}
			if (!res) {
				build.status = 'failed';
				step.status = 'failed';
				thisThis._buildFinished(builderName, build);
				log('build #%d failed on step %d', build.id, build.nextStep);
				return;
			}
			if (step.status === undefined || step.status == 'running')
				step.status = 'succeeded';
			if (step.status == 'succeeded')
				build.stepsSucceeded++;

			while (build.nextStep < build.steps.length &&
				build.steps[build.nextStep].status !== undefined) {
				build.nextStep++;
			}
			if (build.nextStep == build.steps.length) {
				delete build.nextStep;
				if (build.steps.length > build.stepsSucceeded)
					build.status = 'partially-succeeded';
				else
					build.status = 'succeeded';
				if (build.onSuccess !== undefined)
					build.onSuccess();
				thisThis._buildFinished(builderName, build);
				log('build #%d succeeded!', build.id);
				return;
			}
			nextCommand();
		}

		nextCommand = function () {
			var step = build.steps[build.nextStep];
			step.status = 'running';

			if (step.action !== undefined) {
				step.action(build, commandFinished);
			} else {
				var command = step.command;
				if (build.appendJobsFlag && builder.cores > 1)
					command += ' -j' + builder.cores;
				builder.runCommand(command, commandFinished);
			}
		};
		nextCommand();
	};
	/**
	  * @private
	  * @memberof! BuildsManager.prototype
	  * @description Looks for available builders to run all pending builds on.
	  */
	this._tryRunBuilds = function () {
		var availableBuilderNames = [];
		for (var builderName in builderManager.builders) {
			if (builderManager.builders[builderName].status() == 'online')
				availableBuilderNames.push(builderName);
		}
		function nextAvailableBuilderIndex(arch) {
			for (var j in availableBuilderNames) {
				if (availableBuilderNames[j] === undefined)
					continue;
				var builder = builderManager.builders[availableBuilderNames[j]];
				if (builder.status() != 'online')
					continue;
				if (arch !== undefined && builder.data.architecture !== arch)
					continue;
				return j;
			}
			return undefined;
		}

		for (var i in builds) {
			var index = nextAvailableBuilderIndex();
			if (index === undefined)
				return;
			if (builds[i].status != 'pending')
				continue;
			if (builds[i].architecture == 'any') {
				this._runBuildOn(availableBuilderNames[index], builds[i]);
				builderManager.builders[availableBuilderNames[index]].status('busy');
				delete availableBuilderNames[index];
			} else {
				index = nextAvailableBuilderIndex(builds[i].architecture);
				if (index !== undefined) {
					this._runBuildOn(availableBuilderNames[index], builds[i]);
					builderManager.builders[availableBuilderNames[index]].status('busy');
					delete availableBuilderNames[index];
				}
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
		if (build.steps.length === 0) {
			log("WARN: build '%s' has no steps, ignoring", build.description);
			return;
		}

		build.id = nextBuildId++;
		build.status = 'pending';
		build.lastTime = new Date();
		builds[build.id] = build;
		this._writeBuilds();
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
				steps: build.steps.length,
				stepsSucceeded: build.stepsSucceeded
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
