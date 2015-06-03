/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:index'), fs = require('fs');

log('reading config files');
if (!fs.existsSync('data/builders.json')) {
	log('FATAL: no builders configuration file! set one up using kitchen.js.');
	process.exit(1);
}
var builders = JSON.parse(fs.readFileSync('data/builders.json', {encoding: 'UTF-8'}));

log("starting up");

var optimist = require('optimist').default({'port': 8080})
	.describe({
		'port': 'Port to start the HTTP listener on.',
		'help': 'Show this helptext.'
	}).usage('Usage: $0 [options]');

if (optimist.argv['help']) {
	optimist.showHelp();
	process.exit(0);
}

var express = require('express'), app = express();

app.get('/api/recipes', function (request, response) {
	var respJson = {};
	for (var i = 0; i < 1000; i++) {
		respJson["some_package" + (Math.random()*100)] = {
			category: "5",
			version: (Math.random()*100),
			revision: "2",
			lint: true
		};
	}
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify(respJson));
});
app.get('/api/builders', function (request, response) {
	var respJson = {};
	for (var i in builders) {
		respJson[i] = {
			owner: builders[i].owner,
			hrev: undefined,
			cores: undefined,
			architecture: undefined,
			flavor: undefined,
			online: false
		};
	}
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify(respJson));
});

app.use(express.static('web'));
app.listen(optimist.argv['port']);
