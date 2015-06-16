/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:builders'), fs = require('fs'),
	crypto = require('crypto');

if (!fs.existsSync('data/builders.json')) {
	log('FATAL: no builders configuration file! set one up using kitchen.js.');
	process.exit(1);
}

/**
  * @class
  * @description Creates a new Builder object.
  *
  * @param {BuilderManager} builderManager The BuilderManager.
  * @param {string} name The name of this builder.
  * @param {Object} data The data from the `builders.json` file for this builder.
  */
function Builder(builderManager, name, data) {
	/**
	  * @private
	  * @memberof! Builder.prototype
	  * @description The socket the builder is connected with, or
	  *   `null` if the builder is not connected.
	  */
	this._socket = null;
	/**
	  * @public
	  * @memberof! Builder.prototype
	  * @description Contains the data about the builder (name, owner,
	  *   keyHash, etc.) that is stored on disk.
	  */
	this.data = data;
	/**
	  * @public
	  * @memberof! Builder.prototype
	  * @description The name of this builder.
	  */
	this.name = name;

	/**
	  * @public
	  * @memberof! Builder.prototype
	  * @description Sets the status to the specified `newStatus` if `newStatus`
	  *   is a legal status to change to, and returns the new status.
	  * @param {string|undefined} newStatus The status to update (or undefined to
	  *   keep the current status).
	  * @returns {string} The current status.
	  */
	this.status = function (newStatus) {
		if (newStatus != undefined && this._status != 'broken') {
			if (newStatus == 'broken') {
				for (var i in builderManager._builderBrokenCallbacks)
					builderManager._builderBrokenCallbacks[i](this.name);
			}
			return this._status = newStatus;
		}
		return this._status;
	};
	this.status('offline');

	this._runningCommands = {};
	this._nextCommandId = 0;
	/**
	  * @public
	  * @memberof! Builder.prototype
	  * @description Runs the specified command on the builder and returns
	  *   result via the callback.
	  * @param {string} command The shell command to run on the builder.
	  * @param {function|undefined} callback The callback to call when the
	  *   command finishes. The callback will be passed two arguments: exitcode
	  *   (the exitcode of the command, an `int`) and output (the combined
	  *   `stdout` and `stderr` of the command, a `string`).
	  */
	this.runCommand = function (command, callback) {
		var cmdId = 'cmd' + this._nextCommandId;
		this._nextCommandId++;
		this._runningCommands[cmdId] = {
			callback: callback
		};
		this._sendMessage({what: 'command', replyWith: cmdId, command: command});
	};

	/**
	  * @private
	  * @memberof! Builder.prototype
	  * @description Sends the specified JSON message to the builder.
	  * @param {Object} object The object to stringify and send.
	  */
	this._sendMessage = function (object) {
		if (this._socket == null) {
			log('WARN: attempt to write to null socket (builder %s).', this.name);
			return;
		}
		this._socket.write(JSON.stringify(object) + '\n');
	};

	/**
	  * @private
	  * @memberof! Builder.prototype
	  * @description Handles the passed message from the builder.
	  * @param {Object} msg The message to handle.
	  */
	this._handleMessage = function (msg) {
		if (msg.what.indexOf('cmd') == 0) {
			if (!(msg.what in this._runningCommands)) {
				log('WARN: message returned for pending command that does ' +
					'not exist: builder %s, result: %s', this.name, JSON.stringify(msg));
			} else {
				var callback = this._runningCommands[msg.what].callback;
				if (callback !== undefined)
					callback(msg.exitcode, msg.output);
				delete this._runningCommands[msg.what];
			}
			return;
		}

		switch (msg.what) {
		// information about the builder
		case 'coreCount':
			this.cores = msg.count;
			break;
		case 'uname':
			var uname = msg.output.trim().split(' ');
			this.hrev = uname[3].substr(4);
			this.data.architecture = uname[10];
			break;
		case 'archlist':
			var archlist = msg.output.trim().replace(/\n/g, ' ');
			if (archlist == 'x86_gcc2 x86')
				this.data.flavor = 'gcc2hybrid';
			else if (archlist == 'x86 x86_gcc2')
				this.data.flavor = 'gcc4hybrid';
			else if (archlist == this.data.architecture)
				this.data.flavor = 'pure';
			else
				this.data.flavor = 'unknown';
			this.status('online');
			break;

		case 'updateResult':
			if (msg.exitcode != 0) {
				log('update on builder %s failed, marking it as broken', this.name);
				this.status('broken');
			} else if (msg.output.indexOf('Nothing to do.') >= 0) {
				// Already up-to-date.
				break;
			} else {
				log('update on builder %s succeeded, rebooting', this.name);
				this._sendMessage({what: 'restart'});
			}
			break;

		case 'restarting':
		case 'ignore':
			break;
		default:
			log("WARN: couldn't understand this message from '%s': %s", this.name,
				JSON.stringify(msg));
			break;
		}
	};
	/**
	  * @private
	  * @memberof! Builder.prototype
	  * @description Called by the BuilderManager as soon as the builder
	  *   authenticates. Attaches the necessary event handlers to the socket
	  *   for managing incoming messages and state changes.
	  * @param {socket} sock The socket for the authenticated builder.
	  */
	this._authenticated = function (sock) {
		this._socket = sock;

		this.status('busy');
		if (this.status() != 'broken') {
			// startup stuff
			this._sendMessage({what: 'command', replyWith: 'ignore',
				command: 'hey Tracker quit'});
			this._sendMessage({what: 'command', replyWith: 'updateResult',
				command: 'pkgman full-sync -y'});
			// fetch builder info
			this._sendMessage({what: 'getCores'});
			this._sendMessage({what: 'command', replyWith: 'uname',
				command: 'uname -a'});
			this._sendMessage({what: 'command', replyWith: 'archlist',
				command: 'setarch -l'});
			builderManager._ensureHaikuportsTreeOn(this.name);
		}

		var thisThis = this, dataBuf = '', data;
		sock.on('data', function (dat) {
			dataBuf += dat.toString();
			data = dataBuf.split('\n');
			dataBuf = data[data.length - 1];
			delete data[data.length - 1];

			for (var i in data) {
				var msg = JSON.parse(data[i]);
				thisThis._handleMessage(msg);
			}
		});
		sock.on('close', function () {
			log("builder '%s' disconnected", thisThis.name);
			thisThis._socket = null;
			thisThis._status = 'offline';
			delete thisThis.hrev;
			delete thisThis.cores;
			for (var i in thisThis._runningCommands) {
				var callback = thisThis._runningCommands[i].callback;
				if (callback !== undefined)
					callback(999999999, 'Builder disconnected');
				delete thisThis._runningCommands[i];
			}
		});
	};
}

/**
  * @class BuilderManager
  * @description Instatiates a new BuilderManager object.
  *
  * There should only be one instance of BuilderManager running on one
  * machine at any given time, as it assumes complete control of the TCP
  * port `42458`.
  */
module.exports = function () {
	var thisThis = this;

	this.builders = {}; {
		var buildersData = JSON.parse(fs.readFileSync('data/builders.json',
			{encoding: 'UTF-8'}))
		for (var name in buildersData)
			this.builders[name] = new Builder(this, name, buildersData[name]);
	}

	/**
	  * @public
	  * @memberof! BuilderManager.prototype
	  * @description Runs `pkgman full-sync -y` on all builders to update
	  *   them. If one or more of the builders fail to update, it marks them
	  *   as broken.
	  */
	this.updateAllBuilders = function () {
		log('updating builders');
		var cmd = 'pkgman full-sync -y';
		for (var builderName in thisThis.builders) {
			var builder = thisThis.builders[builderName];
			if (builder.status() != 'online')
				continue;
			builder.status('busy');
			builder._sendMessage({what: 'command',
				command: 'pkgman full-sync -y', replyWith: 'updateResult'});
		}
	};

	/**
	  * @private
	  * @memberof! BuilderManager.prototype
	  * @description Updates the HaikuPorts and HaikuPorter trees on the specified
	  *   builder via `git pull`. If one or more of the trees fail to update, the
	  *   builder is marked as broken.
	  * @param {string} builderName The name of the builder to update the trees on.
	  * @param {function|undefined} callback The callback to call after updating
	  *   the trees.
	  */
	this._updateHaikuportsTreeOn = function (builderName, callback) {
		var builder = this.builders[builderName];
		if (builder.status() != 'online')
			return;
		log('updating haikuporter/haikuports trees on %s', builderName);
		var cmd = 'cd ~/haikuporter && git pull && cd ~/haikuports && git pull && cd ~';
		builder.status('busy');
		builder.runCommand(cmd, function (exitcode, output) {
			if (exitcode == 0) {
				builder.status('online');
			} else {
				log('git-pull on builder %s failed: %s', builderName, output.trim());
				builder.status('broken');
			}
			if (callback != undefined)
				callback();
		});
	};
	/**
	  * @public
	  * @memberof! BuilderManager.prototype
	  * @description Updates the HaikuPorts and HaikuPorter trees on all
	  *   currently connected builders.
	  * @param {function|undefined} callback The callback to call after all
	  *   builders are finished updating.
	  */
	this.updateAllHaikuportsTrees = function (callback) {
		var buildersToUpdate = 0, updated = 0;
		for (var i in thisThis._builderSockets) {
			buildersToUpdate++;
			thisThis._updateHaikuportsTreeOn(i, function () {
				updated++;
				if (updated == buildersToUpdate && callback != undefined)
					callback();
			});
		}
		if (buildersToUpdate == 0) {
			// No online builders, so just treat them as updated
			if (callback != undefined)
				callback();
		}
	};
	/**
	  * @private
	  * @memberof! BuilderManager.prototype
	  * @description Ensures there are HaikuPorts and HaikuPorter trees
	  *   set up on the specified builder.
	  * @param {string} builderName The name of the builder to verify
	  *   that there are trees on.
	  */
	this._ensureHaikuportsTreeOn = function (builderName) {
		function treeIsReady() {
			log('haikuporter/haikuports clone/pull successful on %s', builderName);
			var builder = thisThis.builders[builderName];
			builder.runCommand('haikuporter', function (exitcode, output) {
				// Now that we've ensured there's an up-to-date HaikuPorts tree,
				// we can fire the 'builder connected' signal.
				if (builder.status('busy')) {
					builder.status('online');
					for (var i in thisThis._builderConnectedCallbacks)
						thisThis._builderConnectedCallbacks[i](builderName);
				}
			});
		}

		var cmd = 'ls ~/haikuporter/ && ls ~/haikuports/';
		thisThis.builders[builderName].runCommand(cmd, function (exitcode, output) {
			if (exitcode == 0) {
				// they're already there, just update them
				thisThis._updateHaikuportsTreeOn(builderName, treeIsReady);
				return;
			}
			// didn't exit with 0, probably means there's no haikuports/haikuporter
			log('cloning new haikuporter/haikuports trees on %s', builderName);
			cmd = 'cd ~ && git clone https://bitbucket.org/haikuports/haikuporter.git ' +
				'--depth=1 && git clone https://bitbucket.org/haikuports/haikuports.git --depth=1';
			thisThis.builders[builderName].runCommand(cmd, function (exitcode, output) {
				if (exitcode == 0)
					treeIsReady();
				else {
					log('git-clone on builder %s failed: %s', builderName, output.trim());
					thisThis.builders[builderName].status('broken');
				}
			});

			var confFile = '~/config/settings/haikuports.conf';
			cmd = [
				'TREE_PATH=\\"/boot/home/haikuports\\"',
				'PACKAGER=\\"Haiku Kitchen \\<kitchen@server.fake\\>\\"'
				];
			cmd = cmd.join(' >>' + confFile + ' && echo ');
			cmd = 'rm -f ' + confFile + ' && echo ' + cmd + ' >>' + confFile;
			thisThis.builders[builderName].runCommand(cmd, function (exitcode, output) {
				if (exitcode != 0) {
					log('attempt to create haikuports.conf on %s failed: %s',
						builderName, output.trim());
					thisThis.builders[builderName].status('broken');
				}
			});
		});
		thisThis.builders[builderName].runCommand('ln -s ~/haikuporter/haikuporter haikuporter');
	};

	this._builderConnectedCallbacks = [];
	/**
	  * @public
	  * @memberof! BuilderManager.prototype
	  * @description Allows the caller to specify a callback that will be
	  *   called when a builder authenticates. The callback will be passed
	  *   one argument: a string containing the builder's name.
	  * @param {function} callback The callback to call when a builder connects.
	  */
	this.onBuilderConnected = function (callback) {
		this._builderConnectedCallbacks.push(callback);
	};

	this._builderBrokenCallbacks = [];
	/**
	  * @public
	  * @memberof! BuilderManager.prototype
	  * @description Allows the caller to specify a callback that will be
	  *   called when a builder is marked as 'broken'. The callback will be
	  *   passed one argument: a string containing the builder's name.
	  * @param {function} callback The callback to call when a builder is
	  *   marked as broken.
	  */
	this.onBuilderBroken = function (callback) {
		this._builderBrokenCallbacks.push(callback);
	};

	var options = {
		key: fs.readFileSync('data/server.key'),
		cert: fs.readFileSync('data/server.crt')
	};
	var thisThis = this;
	require('tls').createServer(options, function (sock) {
		log('socket opened from %s', sock.remoteAddress);
		var msg = '';
		sock.on('data', function (data) {
			msg += data.toString();
			if (msg.indexOf('\n') < 0)
				return;

			msg = JSON.parse(msg);
			if (msg.what != 'auth') {
				log("AUTHFAIL: %s's first message is not 'auth'!",
					sock.remoteAddress);
				sock.destroy();
				return;
			}
			if (!(msg.name in thisThis.builders)) {
				log("AUTHFAIL: builder's name is '%s' but no known builders " +
					"with that name.", msg.name);
				sock.destroy();
				return;
			}
			if (thisThis.builders[msg.name]._socket != null) {
				log("AUTHFAIL: builder %s is already connected?!", msg.name);
				sock.destroy();
				return;
			}

			// process key
			var builder = thisThis.builders[msg.name];
			var hash = builder.data.keyHash.substr(0, 44),
				salt = builder.data.keyHash.substr(44),
				sha256sum = crypto.createHash('SHA256');
			sha256sum.update(msg.key + salt);
			var hashedKey = sha256sum.digest('base64');
			sock.removeAllListeners('data');
			if (hashedKey != hash) {
				log("AUTHFAIL: hash for key of builder '%s' is '%s', " +
					"but '%s' was expected.", msg.name, hashedKey, hash);
				sock.destroy();
				return;
			}
			log("builder '%s' successfully authenticated from IP %s",
				msg.name, sock.remoteAddress);
			builder._authenticated(sock);
		});
		sock.write('\n'); // indicates to the builder we're ready
	}).listen(42458 /* HAIKU */);
};
