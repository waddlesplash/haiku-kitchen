/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:index'), fs = require('fs'),
	PortsTree = require('./portstree.js'),
	BuilderManager = require('./builders.js'), timers = require('timers');

var argv = require('minimist')(process.argv.slice(2));
if (argv['help']) {
	console.log('The Kitchen server.');
	console.log('Usage: index.js [options]');
	console.log('');
	console.log('Options:');
	console.log('  --port\tPort to start the HTTP listener on.');

	process.exit(0);
}
if (!('port' in argv)) {
	argv.port = 8080;
}

log("starting up");

/*! --------------------- haikuports tree --------------------- */
var portsTree = new PortsTree();
portsTree.update();
timers.setInterval(portsTree.update, 10 * 60 * 1000);

/*! --------------------- builds/builders --------------------- */
var builderManager = new BuilderManager();
var pendingBuilds = {}, activeBuilds = {}, finishedBuilds = {}, nextBuildId = 1;

function jobFinished(job) {
	finishedBuilds[job.id] = job;
	delete activeBuilds[job.id];
	job.lastTime = new Date();
}
function runJobOn(builder, job) {
	log('starting job #%d...', job.id);
	job.curStep = 0;
	function commandFinished(exitcode, output) {
		// TODO: add output to log
		if (!job.handleResult(job.steps[job.curStep], exitcode, output)) {
			job.failed = true;
			jobFinished(job);
			log('job #%d failed on step %d', job.id, job.curStep);
			return;
		}

		job.curStep++;
		if (job.curStep == job.steps.length) {
			jobFinished(job);
			if (job.onSuccess != undefined)
				job.onSuccess();
			delete job.curStep;
			log('job #%d succeeded!', job.id);
			return;
		}
		builderManager.runCommandOn(builder, job.steps[job.curStep], commandFinished);
	}
	builderManager.runCommandOn(builder, job.steps[job.curStep], commandFinished);
}

builderManager.onBuilderConnected(function (name) {
	for (var i in pendingBuilds) {
		if (pendingBuilds[i].architecture == 'any') {
			activeBuilds[i] = pendingBuilds[i];
			delete pendingBuilds[i];
			activeBuilds[i].lastTime = new Date();
			runJobOn(name, activeBuilds[i]);
		}
	}
});

// find recipes that need to be linted & create a build if there are some
var recipesToLint = [];
for (var i in portsTree.recipes) {
	if (!('lint' in portsTree.recipes[i]))
		recipesToLint.push(i);
}
if (recipesToLint.length > 0) {
	var build = {
		id: nextBuildId,
		description: 'lint unlinted recipes',
		noDependencyTracking: true,
		architecture: 'any',
		lastTime: new Date(),
		steps: [],
		handleResult: function (step, exitcode, output) {
			portsTree.recipes[step.split(' ')[2]].lint = (exitcode == 0);
			return true;
		},
		onSuccess: function () {
			portsTree._updateClientCache();
			portsTree._writeCache();
		}
	};
	nextBuildId++;
	for (var i in recipesToLint) {
		build.steps.push('haikuporter --lint ' + recipesToLint[i]);
	}
	pendingBuilds[build.id] = build;
	log('created lint-new-recipes build (#%d)', build.id);
}

/*! ------------------------ webserver ------------------------ */
var express = require('express'), app = express();
app.get('/api/recipes', function (request, response) {
	response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'});
	response.end(portsTree.clientRecipes);
});
app.get('/api/builders', function (request, response) {
	var respJson = {};
	for (var i in builderManager.builders) {
		var builder = builderManager.builders[i];
		respJson[i] = {
			owner: builder.owner,
			hrev: builder.hrev,
			cores: builder.cores,
			architecture: builder.architecture,
			flavor: builder.flavor,
			status: builder.status
		};
	}
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify(respJson));
});
app.get('/api/builds', function (request, response) {
	response.writeHead(200, {'Content-Type': 'application/json'});
	var respJson = {};
	function addBuild(build, status) {
		respJson[build] = {
			id: build.id,
			status: status,
			description: build.description,
			lastTime: build.lastTime,
			steps: build.steps.length
		};
	}
	for (var i in pendingBuilds)
		addBuild(pendingBuilds[i], 'pending');
	for (var i in activeBuilds)
		addBuild(activeBuilds[i], 'running');
	for (var i in finishedBuilds)
		addBuild(finishedBuilds[i], finishedBuilds[i].failed ? 'failed' : 'completed');
	response.end(JSON.stringify(respJson));
});
app.get('/api/build/*', function (request, response) {
	var build = /[^/]*$/.exec(request.url)[0], buildObj, status;
	if (build in pendingBuilds) {
		buildObj = pendingBuilds[build];
		status = 'pending';
	} else if (build in activeBuilds) {
		buildObj = activeBuilds[build];
		status = 'running';
	} else if (build in finishedBuilds) {
		buildObj = finishedBuilds[build];
		status = buildObj.failed ? 'failed' : 'completed';
	} else {
		response.writeHead(404, {'Content-Type': 'text/plain'});
		response.end('404 File Not Found');
		return;
	}

	var respJson = {
		id: build,
		status: status,
		description: buildObj.description,
		lastTime: buildObj.lastTime,
		steps: buildObj.steps,
		curStep: buildObj.curStep
	};
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify(respJson));
});
app.use(express.static('web'));
app.listen(argv['port']);
