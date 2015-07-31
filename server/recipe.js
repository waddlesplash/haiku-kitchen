/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var fs = require('fs');

/**
  * @constructor Recipe
  * @description Parses the recipe at the specified filepath.
  * Currently, only the following attributes of the recipe are stored:
  * `NAME`, `VERSION`, `CATEGORY`, `REVISION`, `ARCHITECTURES`, `PROVIDES*`,
  * `REQUIRES*`, `BUILD_REQUIRES`, and `BUILD_PREREQUIRES`.
  *
  * @param {string} filepath The filepath of the recipe to load in.
  */
module.exports = function (filepath) {
	if (!fs.existsSync(filepath)) {
		throw "File does not exist!";
	}

	var splitPath = filepath.split('/');
	var versionedName = splitPath[splitPath.length - 1].replace('.recipe', '');
	this.name = versionedName.split('-')[0];
	this.version = versionedName.split('-')[1];
	this.category = splitPath[splitPath.length - 3];

	this.provides = [];
	this.requires = [];
	this.build_requires = [];
	this.architectures = [];
	this.secondaryArchitectures = [];
	this.revision = 0;

	/*! This is a really rudimentary .recipe parser. It can't handle all of
	 * Bash's syntax, but it handles enough for our purposes. */
	function parseList(str) {
		str = str.trim();
		var newStr = '';
		for (var i = 0; i < str.length; i++) {
			switch (str[i]) {
			case '#':
				while (i < str.length && str[i] != '\n')
					i++;
				newStr += '\n';
				break;
			default:
				newStr += str[i];
				break;
			}
		}
		return newStr.trim().split(/\n+\t*/);
	}
	var rawRecipe = fs.readFileSync(filepath, {encoding: 'UTF-8'});
	var variables = ['REVISION', 'ARCHITECTURES', 'SECONDARY_ARCHITECTURES', 'PROVIDES',
		'REQUIRES', 'BUILD_REQUIRES', 'BUILD_PREREQUIRES'];
	for (var i = 0; i < rawRecipe.length; i++) {
		if (rawRecipe[i] == '{') {
			var scope = 1;
			while (scope > 0) {
				i++;
				if (rawRecipe[i] == '{')
					scope++;
				else if (rawRecipe[i] == '}')
					scope--;
			}
		}
		for (var v in variables) {
			if ((i === 0 || /\s/.test(rawRecipe[i - 1])) &&
				rawRecipe.substr(i, variables[v].length) == variables[v]) {
				i += variables[v].length;
				while (rawRecipe[i] != '"' && rawRecipe[i] != "'" && i < rawRecipe.length)
					i++;
				var strEndChar = rawRecipe[i];
				i++;
				var str = '';
				while (rawRecipe[i] != strEndChar && i < rawRecipe.length) {
					if (rawRecipe[i] == "\\")
						i++;
					str += rawRecipe[i];
					i++;
				}

				if (variables[v].indexOf('PROVIDES') === 0)
					this.provides.push.apply(this.provides, parseList(str));
				else if (variables[v].indexOf('REQUIRES') === 0)
					this.requires.push.apply(this.requires, parseList(str));
				else if (variables[v] == 'ARCHITECTURES')
					this.architectures.push.apply(this.architectures, str.trim().split(/\s+/g));
				else if (variables[v] == 'SECONDARY_ARCHITECTURES')
					this.secondaryArchitectures.push.apply(this.secondaryArchitectures,
						str.trim().split(/\s+/g));
				else if (variables[v].indexOf('BUILD') === 0)
					this.build_requires.push.apply(this.build_requires, str.trim().split(/\s+/g));
				else
					this[variables[v].toLowerCase()] = str.trim();
			}
		}
	}

	// Hacks to remove $PROVIDES and $REQUIRES
	var newProvides = [];
	for (var i in this.provides) {
		if (this.provides[i] == '$PROVIDES')
			continue;
		newProvides.push(this.provides[i]);
	}
	this.provides = newProvides;
	var newRequires = [];
	for (var i in this.requires) {
		if (this.requires[i] == '$REQUIRES')
			continue;
		newRequires.push(this.requires[i]);
	}
	this.requires = newRequires;

	// Clean up architectures for the "gcc2" hacks. (FIXME: would be nice to fix this
	// in HaikuPorter...)
	var newArches = [];
	function tryAddArch(arch) {
		var plainArch = arch;
		if (arch[0] == '?' || arch[0] == '!')
			plainArch = arch.substring(1);
		var plainLoc = newArches.indexOf(plainArch),
			unkLoc = newArches.indexOf('?' + plainArch),
			notLoc = newArches.indexOf('!' + plainArch);
		if (notLoc == -1 && unkLoc == -1 && plainLoc == -1)
			newArches.push(arch);
		if (notLoc != -1)
			return;

		function replaceArch() {
			if (notLoc != -1)
				newArches[notLoc] = arch;
			else if (plainLoc != -1)
				newArches[plainLoc] = arch;
			else if (unkLoc != -1)
				newArches[unkLoc] = arch;
		}
		if (arch[0] == '!' && (plainLoc != -1 || unkLoc != -1))
			replaceArch();
		else if (arch[0] == '?' && (plainLoc != -1))
			replaceArch();
	}
	for (var i in this.architectures) {
		if (this.architectures[i] == '$ARCHITECTURES')
			continue;
		tryAddArch(this.architectures[i]);
	}
	this.architectures = newArches;
};
