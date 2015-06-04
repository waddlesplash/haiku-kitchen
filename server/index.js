/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:index'), fs = require('fs'),
	PortsTree = require('./portstree.js'), timers = require('timers');

log('reading config files');
if (!fs.existsSync('data/builders.json')) {
	log('FATAL: no builders configuration file! set one up using kitchen.js.');
	process.exit(1);
}
var fBuilders = JSON.parse(fs.readFileSync('data/builders.json', {encoding: 'UTF-8'}));

var optimist = require('optimist').default({'port': 8080})
	.describe({
		'port': 'Port to start the HTTP listener on.',
		'help': 'Show this helptext.'
	}).usage('Usage: $0 [options]');
if (optimist.argv['help']) {
	optimist.showHelp();
	process.exit(0);
}

log("starting up");

/*! --------------------- haikuports tree --------------------- */
var portsTree = new PortsTree();
timers.setInterval(portsTree.update, 10 * 60 * 1000);

/*! ------------------------ builders ------------------------- */
var options = {
	key: fs.readFileSync('data/server.key'),
	cert: fs.readFileSync('data/server.crt')
};

require('tls').createServer(options, function (socket) {
	socket.write(JSON.stringify({what: 'getCpuCount'}) + '\n');
	socket.on("data", function (data) {
		console.log(JSON.parse(data.toString()));
	});
	socket.pipe(socket);
}).listen(42458);

/*! ------------------------ webserver ------------------------ */
var express = require('express'), app = express();
app.get('/api/recipes', function (request, response) {
	response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'});
	response.end(portsTree.clientRecipes);
});
app.get('/api/builders', function (request, response) {
	var respJson = {};
	for (var i in fBuilders) {
		respJson[i] = {
			owner: fBuilders[i].owner,
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
