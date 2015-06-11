/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:builds'), fs = require('fs');

/*! Manages pending/running/finished builds. */
var kKeepBuildsCount = 10;

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

	this._buildFinished = function (builderName, build) {
		builderManager.builders[builderName].status = 'online';
		build.startTime = build.lastTime;
		build.lastTime = new Date();
		this._writeBuilds();
	};
	this._runBuildOn = function (builderName, build) {
		log('starting build #%d...', build.id);
		build.status = 'running';
		build.lastTime = new Date();
		build.builder = builderName;

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
			builderManager.runCommandOn(builderName, build.steps[build.curStep].command, commandFinished);
		}
		builderManager.runCommandOn(builderName, build.steps[build.curStep].command, commandFinished);
	};
	this._tryRunBuilds = function () {
		var availableBuilders = [];
		for (var builderName in builderManager.builders) {
			if (builderManager.builders[builderName].status == 'online')
				availableBuilders.push(builderName);
		}

		for (var i in builds) {
			if (availableBuilders.length == 0)
				return;
			if (builds[i].status != 'pending')
				continue;
			if (builds[i].architecture == 'any') {
				this._runBuildOn(availableBuilders[0], builds[i]);
				availableBuilders[0].status = 'busy';
				delete availableBuilders[0];
			}
		}
	};

	this.addBuild = function (build) {
		build.id = nextBuildId++;
		this._writeBuilds();

		build.status = 'pending';
		builds[build.id] = build;
		log("build #%d ('%s') created", build.id, build.description);
		this._tryRunBuilds();
	};
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
	this.builds = function () {
		return builds;
	};

	builderManager.onBuilderConnected(function (name) {
		thisThis._tryRunBuilds();
	});
};
