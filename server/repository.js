/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:repository'), fs = require('fs'),
	DepGraph = require('dependency-graph').DepGraph;

var arches = [
	['x86_gcc2', 'x86'],
	['x86', 'x86_gcc2'],
	['x86_64']
];
var assumeSatisfied = [
	// Assume these packages are already available in some form.
	'gcc',
	'binutils',
	'libtool',
	'gawk',
	'make',
	'grep',
	'sed',
	'tar'
];
var haikuProvides = JSON.parse(fs.readFileSync('haiku_packages.json'), {encoding: 'UTF-8'});

/**
  * @class RepositoryManager
  * @description Creates a new RepositoryManager object.
  *
  * The RepositoryManager is the high-level manager that takes care of scheduling
  * builds, transferring files, and building the HPKR files for distribution.
  *
  * @param {BuilderManager} builderManager The global BuilderManager instance.
  * @param {BuildsManager} buildsManager The global BuildsManager instance.
  */
module.exports = function (builderManager, buildsManager) {
	/**
	  * @public
	  * @memberof! RepositoryManager.prototype
	  * @description Creates a job to build the specified recipes.
	  * @param {array} recipes The recipes to build.
	  * @param {string} desc The description of the build.
	  */
	this.createJobToBuildRecipes = function (recipes, desc) {
		var build = {
			description: desc ? desc : 'build recipes',
			architecture: 'x86_64', // TODO
			steps: [], // TODO: multitask, TODO: -j<NUM>
			handleResult: function (step, exitcode, output) {
				return (exitcode === 0);
			},
			onSuccess: function () {
				// TODO: fetch files
			}
		};
		for (var i in recipes) {
			build.steps.push({command: 'haikuporter --no-dependencies ' + recipes[i]});
		}
		buildsManager.addBuild(build);
	};

	/**
	  * @public
	  * @memberof! RepositoryManager.prototype
	  * @description Determines what ports need to be built.
	  * @param {string} arch The primary architecture to build for.
	  * @returns {array} recipes An ordered list of recipes to build.
	  */
	this.determinePortsToBuild = function (arch) {
		function versionGreaterThan (v1, v2) {
			if (v1 === undefined && v2 !== undefined)
				return true;
			if (v2 === undefined && v1 !== undefined ||
				v1 === undefined && v2 === undefined)
				return false;
			var v1a = v1.split('.'), v2a = v2.split('.');
			for (var i = 0; i < Math.min(v1.length, v2.length); i++) {
				// First see if they aren't numbers.
				var is1int = /^\d+$/.test(v1a[i]), is2int = /^\d+$/.test(v2a[i]);
				if (!is1int && !is2int) {
					if (v1a[i] != v2a[i])
						return v2a[i] > v1a[i];
					continue;
				}
				if (!is1int && is2int)
					return true;
				if (is1int && !is2int)
					return false;

				// Now interpret them as numbers.
				var v1iI = parseInt(v1a[i]), v2iI = parseInt(v2a[i]);
				if (v2iI > v1iI)
					return true;
				if (v2iI < v1iI)
					return false;
			}
			if (v2a.length > v1a.length)
				return true;
			return false;
		}

		var secondaryArch;
		for (var i in arches) {
			if (arches[i][0] == arch)
				secondaryArch = arches[i][1];
		}

		// Pass 1: Find the highest-version recipe for the arch.
		var highestVersionForArch = {};
		for (var i in global.portsTree.recipes) {
			var recipe = global.portsTree.recipes[i];
			if (recipe.architectures.indexOf(arch) == -1)
				continue;
			if (highestVersionForArch[recipe.name] === undefined ||
				versionGreaterThan(highestVersionForArch[recipe.name].version, recipe.version)) {
				highestVersionForArch[recipe.name] = recipe;
			}
		}

		// Pass 2: Replace $secondaryArchSuffix, strip versions from PROVIDES/REQUIRES in prep.
		// for passing stuff to the depsolver.
		var processedRecipes = {};
		function processItem(str, recipe) {
			str = str
				.replace(/\${secondaryArchSuffix}/g, '')
				.replace(/\$secondaryArchSuffix\b/g, '')
				.replace(/\$portVersion\b/g, recipe.version)
				.replace(/\${portVersion}/g, recipe.version)
				.replace(/\$portName\b/g, recipe.name)
				.replace(/\${portName}/g, recipe.name);
			var ioS = str.indexOf(' ');
			if (ioS != -1)
				str = str.substr(0, ioS);
			return str.toLowerCase();
		}
		for (var i in highestVersionForArch) {
			var recipe = highestVersionForArch[i];
			var provides = [], requires = [];
			for (var i in recipe.provides) {
				var procd = processItem(recipe.provides[i], recipe);
				if (procd.length === 0)
					continue;
				provides.push(procd);
			}
			for (var i in recipe.build_requires) {
				var procd = processItem(recipe.build_requires[i], recipe);
				if (procd.length === 0)
					continue;
				requires.push(procd);
			}
			processedRecipes[recipe.name] = {
				name: recipe.name,
				version: recipe.version,
				provides: provides,
				requires: requires
			};
		}

		// Build dependency list
		var graph = new DepGraph();
		graph.addNode('broken');
		for (var i in processedRecipes)
			graph.addNode(processedRecipes[i].name);
		for (var i in processedRecipes) {
			var recipe = processedRecipes[i];
			if (assumeSatisfied.indexOf(recipe.name) != -1)
				continue; // we should already have the deps needed to build this

			for (var j in recipe.requires) {
				if (haikuProvides.indexOf(recipe.requires[j]) != -1)
					continue; // provided by one of the base Haiku packages

				// Iterate over everything and try to find what provides this.
				var satisfied = false;
				for (var k in processedRecipes) {
					if (processedRecipes[k].provides.indexOf(recipe.requires[j]) != -1) {
						graph.addDependency(recipe.name, processedRecipes[k].name);
						satisfied = true;
						break;
					}
				}
				if (!satisfied)
					graph.addDependency(recipe.name, 'broken');
			}
		}
		graph.dependantsOf('broken').forEach(function (n) { graph.removeNode(n); });
		graph.removeNode('broken');
		console.log(graph.overallOrder());
	};
};
