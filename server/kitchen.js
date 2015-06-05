/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var argv = require('minimist')(process.argv.slice(2)),
	fs = require('fs'), crypto = require('crypto');

if (argv['help'] || process.argv.length < 3) {
	console.log('Application for managing an installation of Haiku Kitchen.');
	console.log('Usage: kitchen.js [command] [options]');
	console.log('');
	console.log('Commands:');
	console.log('  builder:create --name=[name] --owner=[owner]\tCreates a new builder.');
	console.log('  builder:destroy [name]\tDrops all record of the specified builder.');

	process.exit(0);
}

if (!fs.existsSync('data')) {
	fs.mkdirSync('data');
}

var builders;
if (fs.existsSync('data/builders.json'))
	builders = JSON.parse(fs.readFileSync('data/builders.json', {encoding: 'UTF-8'}));
else
	builders = {};

switch (process.argv[2]) {
case 'builder:create':
	if (!('name' in argv)) {
		console.error("Builder must have a name.");
		process.exit(1);
	}
	if (!('owner' in argv)) {
		console.error("Builder must have a named owner.");
		process.exit(2);
	}
	var name = argv['name'];
	if (name.match(/[^A-Z0-9a-z_-]/)) {
		console.error('Illegal characters in builder name, valid ones are [A-Z][a-z][0-9]-_.');
		process.exit(3);
	}
	if (name in builders) {
		console.error("Builder '%s' already exists!", name);
		process.exit(4);
	}
	var clientConf = {name: name};
	builders[name] = {owner: argv['owner']};

	// Get some entropy for a key
	var entropy = "";
	for (var i = 0; i < 10; i++)
		entropy += Math.random() * (Math.random() * 10);
	if (entropy.length < 150) {
		console.error("FATAL: Didn't get enough entropy for a key!");
		process.exit(5);
	}

	// Create the key as the SHA256 of the data, then create the hash
	var sha256sum = crypto.createHash('SHA256');
	sha256sum.update(entropy);
	var key = sha256sum.digest('hex');

	// Get some more entropy for the salt
	entropy = Math.floor(Math.random() * 10000000).toString(16);
	var salt = entropy.substr(0, 4);
	if (salt.length < 4) {
		console.error("FATAL: Didn't get enough entropy for the salt!");
		process.exit(6);
	}

	// Hash the key and the salt
	sha256sum = crypto.createHash('SHA256');
	sha256sum.update(key + salt);
	var hash = sha256sum.digest('base64') + salt;
	builders[name].keyHash = hash;
	clientConf.key = key;

	fs.writeFileSync('data/builders.json', JSON.stringify(builders));
	console.log('Builder created successfully. builder.conf:');
	console.log(JSON.stringify(clientConf, null, 2));
	break;

case 'builder:destroy':
	var name = process.argv[3];
	if (!(name in builders)) {
		console.error("Builder '%s' does not exist!", name);
		process.exit(7);
	}
	delete builders[name];
	fs.writeFileSync('data/builders.json', JSON.stringify(builders));
	console.log("Builder '%s' destroyed successfully.", name);
	break;

default:
	console.error('Invalid command specified!');
	process.exit(8);
	break;
}
