/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen'), fs = require('fs'),
	shell = require('shelljs'), timers = require('timers'), zlib = require('zlib'),
	glob = require('glob'), Recipe = require('./recipe.js').recipe;

if (!shell.which('git')) {
	log('FATAL: git must be installed to run this script.');
	process.exit(2);
}

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
var fRecipes, fClientRecipes;
function updateClientCache() {
	var newClientRecipes = [];
	for (var i in fRecipes) {
		newClientRecipes.push({
			name: fRecipes[i].name,
			category: fRecipes[i].category,
			version: fRecipes[i].version,
			revision: fRecipes[i].revision,
			lint: '?'
		});
	}
	zlib.gzip(JSON.stringify(newClientRecipes), {level: 9}, function (err, res) {
		fClientRecipes = res;
	});
}
function updateCacheFor(files) {
	log('cache: updating ' + files.length + ' entries...');
	for (var i in files) {
		var recipe = new Recipe(files[i]);
		fRecipes[recipe.name + '-' + recipe.version] = recipe;
	}
	updateClientCache();
	log('cache: recipe metadata update complete.');
}
function completeCacheRebuild() {
	fRecipes = {};
	updateCacheFor(glob.sync('cache/haikuports/*-*/*/*.recipe'));
}
function createCache() {
	log('cache: creating cache from scratch...');
	shell.rm('-rf', 'cache');
	shell.mkdir('cache');
	shell.cd('cache');
		log('cache: cloning haikuports...');
		var res = shell.exec('git clone --depth=1 https://bitbucket.org/haikuports/haikuports.git',
			{silent: true});
		if (res.code !== 0) {
			log('FATAL: cloning haikuports failed: ' + res.output);
			process.exit(3);
		}
	shell.cd('..');
	completeCacheRebuild();
}

if (!fs.existsSync('cache/haikuports/')) {
	createCache();
} else {
	completeCacheRebuild();
}

function updateHaikuportsTree() {
	log('running git-pull...');
	shell.cd('cache/haikuports');
		shell.exec('git pull --ff-only', {silent: true}, function (code, output) {
			if (code) {
				log('git-pull failed, deleting cache');
				createCache();
			} else if (output.indexOf('Already up-to-date.') >= 0) {
				log('git-pull finished, no changes');
			} else {
				log('git-pull finished, updating cache...');
				completeCacheRebuild();
			}
		});
	shell.cd('../..');
}
updateHaikuportsTree();
timers.setInterval(updateHaikuportsTree, 10 * 60 * 1000);

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
	response.end(fClientRecipes);
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
