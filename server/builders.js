/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:builders'), fs = require('fs'),
	path = require('path'), crypto = require('crypto'), shell = require('shelljs');

if (!shell.which('sha256sum')) {
	console.error('FATAL: sha256sum (from coreutils) must be installed.');
	process.exit(1);
}

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
  * @param {Builder} Builder The builder that the file is being transferred from.
  * @param {integer} fileSize The size of the file that is being transferred.
  * @param {string} fileName The name of the local file to write to.
  * @param {function|undefined} callback The callback to call once the transfer completes.
  */
function DataWriter(builder, fileSize, fileName, hash, callback) {
	this._done = false;
	this._accumulatedSize = 0;
	this._failed = false;
	this._queuedData = [];
	var thisThis = this;

	/**
	  * @public
	  * @memberof! DataWriter.prototype
	  * @description Sets the socket handled by this DataWriter.
	  */
	this.socket = function (sock) {
		log("file transfer '%s' from %s started", fileName, builder.name);
		sock.on('data', function (data) {
			thisThis._queuedData.push(data);
			thisThis._accumulatedSize += data.length;
			thisThis._done = (thisThis._accumulatedSize == fileSize);
			if (thisThis._done) {
				sock.destroy();
			}
			thisThis._writeQueuedData();
		});
		sock.on('error', function (err) {
			if (thisThis._done)
				return;
			log("file transfer '%s' socket errored: %s", fileName, err);
			try { sock.destroy(); } catch (e) {}
			thisThis._failed = true;
			thisThis._writeQueuedData();
		});
		sock.on('close', function () {
			if (thisThis._done)
				return;
			log("file transfer '%s' disconnected", fileName);
			thisThis._failed = true;
			thisThis._writeQueuedData();
		});
	};

	this._writing = false;
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
			log("file transfer '%s' failed", fileName);
			this._queuedData = [];
			if (callback) {
				callback(true);
				callback = undefined;
			}
			return;
		}
		if (this._queuedData.length === 0) {
			if (this._done) {
				shell.exec('sha256sum ' + fileName, {silent: true}, function (code, output) {
					if (code !== 0) {
						log("failed to hash file '%s' on server", fileName);
						if (callback) {
							callback(true);
							callback = undefined;
						}
						return;
					}
					var serverHash = output.trim().substr(0, 64);
					if (serverHash != hash) {
						log("transfer '%s' hashes don't match! client: %s server: %s", fileName, hash, serverHash);
						if (callback) {
							callback(true);
							callback = undefined;
						}
						return;
					}
					log("file transfer '%s' complete", fileName);
					if (callback) {
						callback(false);
						callback = undefined;
					}
				});
			}
			return;
		}

		this._writing = true;
		fs.appendFile(fileName,	this._queuedData[0],
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
			break;
		case 'archlist':
			var archlist = msg.output.trim().replace(/\n/g, ' ').split(' ');
			this.data.architecture = archlist[0];
			if (archlist.length == 2)
				this.data.flavor = 'hybrid';
			else
				this.data.flavor = 'pure';
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
	this._fileTransfers = [];
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
		var thisThis = this;
		var localFile = 'cache/filetransfer/' + path.basename(filePath);
		fs.unlink(localFile, function (err) { /* probably ENOENT */ });
		this.runCommand('stat -c %s ' + filePath + ' && sha256sum ' + filePath, function (exitcode, output) {
			if (exitcode !== 0) {
				log('attempt to stat & checksum file for transfer on %s failed: %s',
					thisThis.name, output.trim());
				if (callback)
					callback(true);
				return;
			}
			thisThis._fileTransfer = true; // as next command will actually start it
			var output = output.split("\n");

			var filesize = parseInt(output[0].trim()), hash = output[1].substr(0, 64);
			var transfer = {
				file: filePath,
				dataWriter: new DataWriter(thisThis, filesize, localFile, hash, function (err) {
					if (callback)
						callback(err);
					thisThis._fileTransfers = thisThis._fileTransfers.slice(1);
					thisThis._fileTransfer = false;
					thisThis._sendPendingMessages();
				})
			};
			thisThis._fileTransfers.push(transfer);
			global.builderManager.filetransfers.push({
				addr: thisThis._socket.remoteAddress,
				dataWriter: transfer.dataWriter
			});
		});
		this.runCommand('test -f ' + filePath + ' && cat ' + filePath +
			' | openssl s_client -connect KITCHEN_SERVER_ADDRESS:5824 -quiet');
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
			this._fetchMetadata();
		}

		var messageHandler, dataBuf = '', msgs;
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
				thisThis._handleMessage(msg);
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
  * port `5824`.
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
		log('updating haikuporter/haikuports trees on %s', builderName);
		var cmd = 'cd ~/haikuporter && git pull && cd ~/haikuports && git pull && cd ~';
		builder.status('busy');
		builder.runCommand(cmd, function (exitcode, output) {
			if (exitcode === 0) {
				builder.status('online');
			} else {
				log('git-pull on builder %s failed: %s', builderName, output.trim());
				builder.status('broken');
				return;
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
				builder.status('online');
				for (var i in thisThis._builderConnectedCallbacks)
					thisThis._builderConnectedCallbacks[i](builderName);
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
					return;
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

	this.filetransfers = [];

	var options = {
		key: fs.readFileSync('data/server.key'),
		cert: fs.readFileSync('data/server.crt')
	};
	require('tls').createServer(options, function (sock) {
		log('socket opened from %s', sock.remoteAddress);
		for (var i in thisThis.filetransfers) {
			var transfer = thisThis.filetransfers[i];
			if (transfer.addr == sock.remoteAddress) {
				transfer.dataWriter.socket(sock);
				thisThis.filetransfers.splice(i, 1);
				return;
			}
		}

		var msg = '';
		sock.on('data', function (data) {
			msg += data.toString();
			if (msg.indexOf('\n') < 0)
				return;

			try {
				msg = JSON.parse(msg);
			} catch (e) {
				msg = {};
			}
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
	}).listen(5824 /* KTCH */);
};
