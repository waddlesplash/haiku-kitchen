/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:builders'), fs = require('fs'),
	path = require('path'), crypto = require('crypto');

if (!fs.existsSync('data/builders.json')) {
	console.error('FATAL: no builders configuration file! set one up using kitchen.js.');
	process.exit(1);
}
if (!fs.existsSync('data/server.key')) {
	console.error('FATAL: no server keyfile! set one up using OpenSSL.');
	process.exit(1);
}

/**
  * @class
  * @description Creates a new DataWriter object.
  *
  * The DataWriter class takes care of writing the transferred file data to disk,
  * and calling the callback once the transfer completes.
  *
  * @param {string} transferName The name of the file transfer this DataWriter
  *  is responsible for.
  * @param {string} fileName The name of the local file to write to.
  * @param {function|undefined} callback The callback to call once the transfer completes.
  */
function DataWriter(transferName, fileName, callback) {
	this._writing = false;
	this._done = false;
	this._failed = false;
	this._queuedData = [];

	/**
	  * @public
	  * @memberof! DataWriter.prototype
	  * @description Adds another chunk of (Base64-encoded) data to the write queue.
	  */
	this.append = function (data) {
		if (this._failed)
			return;
		this._queuedData.push(data);
		this._writeQueuedData();
	};
	/**
	  * @public
	  * @memberof! DataWriter.prototype
	  * @description Marks the transfer as "done"; that is, no more data will be
	  *  added to the queue.
	  */
	this.done = function () {
		if (this._failed)
			return;
		this._done = true;
		this._writeQueuedData();
	};
	/**
	  * @public
	  * @memberof! DataWriter.prototype
	  * @description Marks the transfer as "failed".
	  */
	this.failed = function () {
		if (this._failed)
			return;
		this._failed = true;
		this._writeQueuedData();
	};

	/**
	  * @private
	  * @memberof! DataWriter.prototype
	  * @description Writes a chunk of the queued data to disk.
	  *
	  * Once it finishes writing the data, it calls itself to write the next chunk.
	  * If there are no more chunks and the "done" flag is set, it calls the callback.
	  */
	this._writeQueuedData = function () {
		if (this._writing)
			return;
		if (this._failed) {
			fs.unlink(fileName, function (err) {});
			log("file transfer '%s' failed", transferName);
			this._queuedData = [];
			if (callback) {
				callback(true);
				callback = undefined;
			}
			return;
		}
		if (this._queuedData.length === 0) {
			if (this._done) {
				log("file transfer '%s' complete", transferName);
				if (callback) {
					callback(false);
					callback = undefined;
				}
			}
			return;
		}

		this._writing = true;
		var thisThis = this;
		fs.appendFile(fileName,	new Buffer(this._queuedData[0], 'base64'),
			function () {
				thisThis._queuedData.splice(0, 1); // delete first item
				thisThis._writing = false;
				thisThis._writeQueuedData();
			});
	};
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
	if (!fs.existsSync('cache/filetransfer')) {
		fs.mkdirSync('cache/filetransfer');
	}

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
		if (newStatus !== undefined && this._status != 'broken') {
			if (newStatus == 'broken') {
				for (var i in builderManager._builderBrokenCallbacks)
					builderManager._builderBrokenCallbacks[i](this.name);
			}
			return (this._status = newStatus);
		}
		return this._status;
	};
	this.status('offline');

	/**
	  * @private
	  * @memberof! Builder.prototype
	  * @description Sends messages to collect information about the builder.
	  */
	this._fetchMetadata = function () {
		this._sendMessage({what: 'getCores'});
		this._sendMessage({what: 'command', replyWith: 'uname',
			command: 'uname -a'});
		this._sendMessage({what: 'command', replyWith: 'archlist',
			command: 'setarch -l'});
		builderManager._ensureHaikuportsTreeOn(this.name);
	};

	/**
	  * @private
	  * @memberof! Builder.prototype
	  * @description Handles the passed message from the builder.
	  * @param {Object} msg The message to handle.
	  */
	this._handleMessage = function (msg) {
		if (!('what' in msg))
			return;

		if (msg.what.indexOf('cmd') === 0) {
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
			this.data.architecture = uname[9];
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
			break;

		case 'updateResult':
			if (msg.exitcode !== 0) {
				log('update on builder %s failed, marking it as broken', this.name);
				this.status('broken');
			} else if (msg.output.indexOf('Nothing to do.') >= 0) {
				// See if we have the builder metadata, and get it if we don't
				if (this.data.flavor === undefined) {
					this._fetchMetadata();
				}
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

	this._pendingMessages = [];
	/**
	  * @private
	  * @memberof! Builder.prototype
	  * @description Sends the specified JSON message to the builder.
	  * @param {Object} object The object to stringify and send.
	  */
	this._sendMessage = function (object) {
		if (this._socket === null) {
			log('WARN: attempt to write to null socket (builder %s).', this.name);
			return;
		}
		if (this._fileTransfer) {
			// Queue the message, we're running a file transfer ATM
			this._pendingMessages.push(object);
			return;
		}
		this._socket.write(JSON.stringify(object) + '\n');
	};
	/**
	  * @private
	  * @memberof! Builder.prototype
	  * @description Sends all pending messages to the builder.
	  */
	this._sendPendingMessages = function () {
		for (var i in this._pendingMessages) {
			this._sendMessage(this._pendingMessages[i]);
			delete this._pendingMessages[i];
		}
	};

	this._fileTransfer = false;
	this._nextTransferId = 0;
	/**
	  * @public
	  * @memberof! Builder.prototype
	  * @description Transfers the specified file from the builder to the
	  *   server.
	  * @param {string} filePath The path of the file to transfer
	  * @param {function|undefined} callback The callback to call when the
	  *   command finishes. The callback will be passed one argument, "err",
	  *   which will either be undefined or an error.
	  */
	this.transferFile = function (filePath, callback) {
		var ftId = 'ft' + this._nextTransferId;
		this._nextTransferId++;
		var localFile = 'cache/filetransfer/' + path.basename(filePath);
		this._runningCommands[ftId] = {
			file: filePath,
			dataWriter: new DataWriter(filePath, localFile, callback)
		};
		fs.unlink(localFile, function (err) { /* probably ENOENT */ });
		this._sendMessage({what: 'transferFile', replyWith: ftId, file: filePath});
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
		var thisThis = this;

		this.status('busy');
		if (this.status() != 'broken') {
			// startup stuff
			this._sendMessage({what: 'command', replyWith: 'ignore',
				command: 'hey Tracker quit'});
			this._fetchMetadata();
		}

		var messageHandler, fileTransferHandler, fileTransferId, dataBuf = '', msgs;
		function dataHandler(newData) {
			if (newData === undefined)
				return;

			dataBuf += newData.toString();
			var lines = dataBuf.split('\n');
			dataBuf = lines[lines.length - 1];
			delete lines[lines.length - 1];

			msgs = [];
			for (var i in lines) {
				var json;
				try {
					json = JSON.parse(lines[i]);
				} catch (e) {
					log("got invalid JSON: '%s'", lines[i]);
					continue;
				}
				msgs.push(json);
			}
		}

		messageHandler = function (dat) {
			dataHandler(dat);
			for (var i in msgs) {
				var msg = msgs[i];
				if (msg.what == 'transferStarting') {
					sock.removeAllListeners('data');
					sock.on('data', fileTransferHandler);
					this._fileTransfer = true;
					fileTransferId = msg.id;
					log("transferring file '%s' from builder '%s'...",
						thisThis._runningCommands[fileTransferId].file,
						thisThis.name);

					var newMsgs = [];
					for (var j = i + 1; j < msgs.length; j++)
						newMsgs.push(msgs[i]);
					msgs = newMsgs;
					fileTransferHandler();
					break;
				}
				thisThis._handleMessage(msg);
			}
		};

		fileTransferHandler = function (data) {
			var transferObj = thisThis._runningCommands[fileTransferId];
			dataHandler(data);

			var failed = false;
			function sockClosed() {
				if (failed)
					return; // we shouldn't get here...
				failed = true;
				transferObj.dataWriter.failed();
			}
			if (data === undefined)
				sock.on('close', sockClosed);
			for (var i in msgs) {
				if ('what' in msgs[i] || failed) {
					sock.removeListener('close', sockClosed);
					sock.removeAllListeners('data');
					sock.on('data', messageHandler);
					this._fileTransfer = false;
					transferObj.dataWriter.done();

					messageHandler(undefined);
					thisThis._sendPendingMessages();
					return;
				}
				transferObj.dataWriter.append(msgs[i].data);
			}
		};
		sock.on('data', messageHandler);

		var pinger = function () {
			// Just send something to make sure the socket is alive
			thisThis._sendMessage({what: 'getCores'});
		};
		var intervalObject = setInterval(pinger, 10 * 60 * 1000);
		var closeHandler = function () {
			thisThis._socket = null;
			thisThis._status = 'offline';
			clearInterval(intervalObject);
			delete thisThis.hrev;
			delete thisThis.cores;
			for (var i in thisThis._runningCommands) {
				var callback = thisThis._runningCommands[i].callback;
				if (callback !== undefined)
					callback(999999999, 'Builder disconnected');
				delete thisThis._runningCommands[i];
			}
		};
		sock.on('error', function (err) {
			log("builder '%s' socket errored: %s", thisThis.name, err);
			try { thisThis._socket.destroy(); } catch (e) {}
			closeHandler();
		});
		sock.on('close', function () {
			log("builder '%s' disconnected", thisThis.name);
			closeHandler();
		});
	};
}

/**
  * @class BuilderManager
  * @description Creates a new BuilderManager object.
  *
  * There should only be one instance of BuilderManager running on one
  * machine at any given time, as it assumes complete control of the TCP
  * port `42458`.
  */
module.exports = function () {
	var thisThis = this;

	this.builders = {}; {
		var buildersData = JSON.parse(fs.readFileSync('data/builders.json',
			{encoding: 'UTF-8'}));
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
			if (builder.status() != 'online') {
				log('not updating builder \'%s\' as its status is not \'online\'', builder.name);
				continue;
			}
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
			if (exitcode === 0) {
				builder.status('online');
			} else {
				log('git-pull on builder %s failed: %s', builderName, output.trim());
				builder.status('broken');
			}
			if (callback !== undefined)
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
		var buildersToUpdate = 0, updated = 0, updateCallback = function () {
				updated++;
				if (updated == buildersToUpdate && callback !== undefined)
					callback();
			};
		for (var i in thisThis._builderSockets) {
			buildersToUpdate++;
			thisThis._updateHaikuportsTreeOn(i, updateCallback);
		}
		if (buildersToUpdate === 0) {
			// No online builders, so just treat them as updated
			if (callback !== undefined)
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
		var builder = thisThis.builders[builderName];
		builder.runCommand(cmd, function (exitcode, output) {
			if (exitcode === 0) {
				// they're already there, just update them
				thisThis._updateHaikuportsTreeOn(builderName, treeIsReady);
				return;
			}
			// didn't exit with 0, probably means there's no haikuports/haikuporter
			log('cloning new haikuporter/haikuports trees on %s', builderName);
			cmd = 'cd ~ && git clone https://github.com/haikuports/haikuporter.git ' +
				'--depth=1 && git clone https://github.com/haikuports/haikuports.git --depth=1';
			builder.runCommand(cmd, function (exitcode, output) {
				if (exitcode === 0)
					treeIsReady();
				else {
					log('git-clone on builder %s failed: %s', builderName, output.trim());
					builder.status('broken');
				}
			});

			var confFile = '~/config/settings/haikuports.conf';
			cmd = [
				'TREE_PATH=\\"/boot/home/haikuports\\"',
				'PACKAGER=\\"Haiku Kitchen \\<kitchen@server.fake\\>\\"'
				];
			if (builder.data.architecture == 'x86_gcc2')
				cmd.push('SECONDARY_TARGET_ARCHITECTURES=\\"x86\\"');
			else if (builder.data.architecture == 'x86')
				cmd.push('SECONDARY_TARGET_ARCHITECTURES=\\"x86_gcc2\\"');
			cmd = cmd.join(' >>' + confFile + ' && echo ');
			cmd = 'rm -f ' + confFile + ' && echo ' + cmd + ' >>' + confFile;
			builder.runCommand(cmd, function (exitcode, output) {
				if (exitcode !== 0) {
					log('attempt to create haikuports.conf on %s failed: %s',
						builderName, output.trim());
					builder.status('broken');
				}
			});
		});
		builder.runCommand('ln -s ~/haikuporter/haikuporter /system/non-packaged/bin/haikuporter');
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
			if (thisThis.builders[msg.name]._socket !== null) {
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
