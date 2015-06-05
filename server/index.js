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

/*! ------------------------ builders ------------------------- */
var builderManager = new BuilderManager();

/*! ------------------------ webserver ------------------------ */
var express = require('express'), app = express();
app.get('/api/recipes', function (request, response) {
	response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'});
	response.end(portsTree.clientRecipes);
});
app.get('/api/builders', function (request, response) {
	var respJson = {};
	for (var i in builderManager.builders) {
		respJson[i] = {
			owner: builderManager.builders[i].owner,
			hrev: builderManager.builders[i].hrev,
			cores: builderManager.builders[i].cores,
			architecture: builderManager.builders[i].architecture,
			flavor: builderManager.builders[i].flavor,
			online: ('ip' in builderManager.builders[i])
		};
	}
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify(respJson));
});
app.use(express.static('web'));
app.listen(argv['port']);
