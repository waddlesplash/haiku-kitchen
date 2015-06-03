/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:index'), fs = require('fs'),
	shell = require('shelljs'), glob = require('glob'),
	Recipe = require('./recipe.js').recipe;

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
function createCache() {
	log('cache: creating recipe metadata cache...');
	fRecipes = [];
	fClientRecipes = [];
	var files = glob.sync('cache/haikuports/*-*/*/*.recipe');
	for (var i in files) {
		var recipe = new Recipe(files[i]);
		fRecipes.push(recipe);
		fClientRecipes.push({
			name: recipe.name,
			category: recipe.category,
			version: recipe.version,
			revision: recipe.revision,
			lint: '?'
		});
	}
	fClientRecipes = JSON.stringify(fClientRecipes);
	log('cache: recipe metadata cache build complete.');
}

if (!fs.existsSync('cache/haikuports/')) {
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
}
createCache();

/*! ------------------------ webserver ------------------------ */
var express = require('express'), app = express();
app.get('/api/recipes', function (request, response) {
	response.writeHead(200, {'Content-Type': 'application/json'});
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
