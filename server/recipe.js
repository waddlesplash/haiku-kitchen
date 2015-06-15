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
	this.revision = 0;

	/*! This is a really rudimentary .recipe parser. It can't handle all of
	 * Bash's syntax, but it handles enough for our purposes. */
	var rawRecipe = fs.readFileSync(filepath, {encoding: 'UTF-8'});
	for (var i = 0; i < rawRecipe.length; i++) {
		var variables = ['REVISION', 'ARCHITECTURES', 'PROVIDES', 'REQUIRES',
			'BUILD_REQUIRES', 'BUILD_PREREQUIRES'];
		for (var v in variables) {
			if ((i == 0 || /\s/.test(rawRecipe[i - 1])) &&
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
					this.provides.push.apply(this.provides, str.trim().split(/\n+\t*/g));
				else if (variables[v].indexOf('REQUIRES') === 0)
					this.requires.push.apply(this.requires, str.trim().split(/\n+\t*/g));
				else if (variables[v] == 'ARCHITECTURES')
					this.architectures.push.apply(this.architectures, str.trim().split(/\s+/g));
				else if (variables[v].indexOf('BUILD') === 0)
					this.build_requires.push.apply(this.build_requires, str.trim().split(/\s+/g));
				else
					this[variables[v].toLowerCase()] = str.trim();
			}
		}
	}
};
