/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var argv = require('minimist')(process.argv.slice(2)),
	fs = require('fs'), crypto = require('crypto');

if (argv.help || process.argv.length < 3) {
	console.log('Application for managing an installation of Haiku Kitchen.');
	console.log('Usage: kitchen.js [command] [options]');
	console.log('');
	console.log('Commands:');
	console.log('  builder:create --name=[name] --owner=[owner]\tCreates a new builder.');
	console.log('  builder:destroy [name]\tDrops all record of the specified builder.');
	console.log('');
	console.log('  config:irc --nick=[nick] --channels="#channel1,#channel2" [--pass=password]');

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
	var name = argv.name;
	if (name.match(/[^A-Z0-9a-z_-]/)) {
		console.error('Illegal characters in builder name, valid ones are [A-Z][a-z][0-9]-_.');
		process.exit(3);
	}
	if (name in builders) {
		console.error("Builder '%s' already exists!", name);
		process.exit(4);
	}
	var clientConf = {name: name};
	builders[name] = {owner: argv.owner};

	// Get some entropy for a key
	function getEntropy(len) {
		try {
			return crypto.randomBytes(len);
		} catch (ex) {
			console.error('FATAL: getting entropy failed: ', ex);
			process.exit(5);
		}
	}

	// Create the key as the SHA256 of the data, then create the hash
	var sha256sum = crypto.createHash('SHA256');
	sha256sum.update(getEntropy(150));
	var key = sha256sum.digest('hex');

	// Hash the key and the salt
	var salt = getEntropy(6).toString('base64').substr(0, 4);
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

case 'config:irc':
	if (!('nick' in argv)) {
		console.error("'config:irc' requires the 'nick' option.");
		process.exit(1);
	}
	if (!('channels' in argv)) {
		console.error("'config:irc' requires the 'channels' option.");
		process.exit(1);
	}
	var ircConfig = {
		nick: argv.nick,
		channels: argv.channels.split(',')
	};
	if ('pass' in argv) {
		ircConfig.password = argv.pass;
	}
	fs.writeFileSync('data/irc.json', JSON.stringify(ircConfig));
	break;

default:
	console.error('Invalid command specified!');
	process.exit(8);
	break;
}
