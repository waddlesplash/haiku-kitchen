/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:builds'), fs = require('fs');

/*! Manages pending/running/finished builds. */

module.exports = function (builderManager) {
	var builds = {}, nextBuildId = 1, availableBuilders = [];

	function buildFinished(builder, build) {
		availableBuilders.push(builder);
		build.lastTime = new Date();
	}
	function runBuildOn(builder, build) {
		log('starting build #%d...', build.id);
		build.status = 'running';
		build.lastTime = new Date();

		build.curStep = 0;
		function commandFinished(exitcode, output) {
			// TODO: add output to log
			if (!build.handleResult(build.steps[build.curStep], exitcode, output)) {
				build.status = 'failed';
				buildFinished(builder, build);
				log('build #%d failed on step %d', build.id, build.curStep);
				return;
			}

			build.curStep++;
			if (build.curStep == build.steps.length) {
				buildFinished(builder, build);
				if (build.onSuccess != undefined)
					build.onSuccess();
				delete build.curStep;
				build.status = 'succeeded';
				log('build #%d succeeded!', build.id);
				return;
			}
			builderManager.runCommandOn(builder, build.steps[build.curStep], commandFinished);
		}
		builderManager.runCommandOn(builder, build.steps[build.curStep], commandFinished);
	}
	function tryRunBuilds() {
		for (var i in builds) {
			if (availableBuilders.length == 0)
				return;
			if (builds[i].status != 'pending')
				continue;
			if (builds[i].architecture == 'any') {
				runBuildOn(availableBuilders[0], builds[i]);
				delete availableBuilders[0];
			}
		}
	}

	this.addBuild = function (build) {
		build.id = nextBuildId++;
		build.status = 'pending';
		builds[build.id] = build;
		log("build #%d ('%s') created", build.id, build.description);
		tryRunBuilds();
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
			return (a.id - b.id);
		});
		return ret;
	};
	this.builds = function () {
		return builds;
	};

	builderManager.onBuilderConnected(function (name) {
		availableBuilders.push(name);
		tryRunBuilds();
	});
};
