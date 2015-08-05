/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:repository'), fs = require('fs'),
	IRC = require('internet-relay-chat'),
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
	  * @private
	  * @memberof! RepositoryManager.prototype
	  * @description Private handler for _dependencyGraphFor().
	  */
	this._buildDependencyGraph = function (arch, secondaryArch) {
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

		// Pass 1: Find the highest-version recipe for the arch.
		function filterInto(object, recipes, variable, architecture) {
			if (architecture === undefined)
				return;
			for (var i in recipes) {
				var recipe = recipes[i];
				if (recipe[variable].indexOf(architecture) == -1)
					continue;
				if (object[recipe.name] === undefined ||
					versionGreaterThan(object[recipe.name].version, recipe.version)) {
					object[recipe.name] = recipe;
				}
			}
		}
		var highestVersionForArch = {}, highestVersionForSecondaryArch = {};
		filterInto(highestVersionForArch, global.portsTree.recipes, 'architectures', arch);
		filterInto(highestVersionForSecondaryArch, global.portsTree.recipes,
			'secondaryArchitectures', secondaryArch);

		// Pass 2: Replace $secondaryArchSuffix, strip versions from PROVIDES/REQUIRES in prep.
		// for passing stuff to the depsolver.
		var processedRecipes = {};
		function processItem(str, recipe, secondaryArchSuffix) {
			str = str
				.replace(/\${secondaryArchSuffix}/g, secondaryArchSuffix)
				.replace(/\$secondaryArchSuffix\b/g, secondaryArchSuffix)
				.replace(/\$portVersion\b/g, recipe.version)
				.replace(/\${portVersion}/g, recipe.version)
				.replace(/\$portName\b/g, recipe.name)
				.replace(/\${portName}/g, recipe.name);
			var ioS = str.indexOf(' ');
			if (ioS != -1)
				str = str.substr(0, ioS);
			return str.toLowerCase();
		}
		function processHighestVersions(highestVersions, secondaryArchSuffix) {
			for (var i in highestVersions) {
				var recipe = highestVersions[i];
				var provides = [], requires = [];
				for (var i in recipe.provides) {
					var procd = processItem(recipe.provides[i], recipe, secondaryArchSuffix);
					if (procd.length === 0)
						continue;
					provides.push(procd);
				}
				for (var i in recipe.build_requires) {
					var procd = processItem(recipe.build_requires[i], recipe, secondaryArchSuffix);
					if (procd.length === 0)
						continue;
					requires.push(procd);
				}
				processedRecipes[recipe.name + secondaryArchSuffix] = {
					name: recipe.name + secondaryArchSuffix,
					version: recipe.version,
					provides: provides,
					requires: requires
				};
			}
		}
		processHighestVersions(highestVersionForArch, '');
		processHighestVersions(highestVersionForSecondaryArch, '_' + secondaryArch);

		// Build dependency list
		var graph = new DepGraph();
		graph.addNode('broken');
		for (var i in processedRecipes)
			graph.addNode(processedRecipes[i].name);
		for (var i in processedRecipes) {
			var recipe = processedRecipes[i];
			if (assumeSatisfied.indexOf(recipe.name) != -1 ||
				assumeSatisfied.indexOf(recipe.name.replace('_' + secondaryArch, '')) != -1)
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
		return graph;
	};

	/**
	  * @private
	  * @memberof! RepositoryManager.prototype
	  * @description Determines what ports need to be built.
	  * @param {string} arch The primary architecture to build for.
	  */
	this._dependencyGraphFor = function (arch, secondaryArch) {
		try {
			var graph = this._buildDependencyGraph(arch, secondaryArch);
			graph.overallOrder(); // so we catch any possible exceptions
			return graph;
		} catch (e) {
			log('CATCH: _buildDependencyGraph failed (for arch %s):', arch);
			log(e);
			// Don't send the exception to IRC in case it contains sensitive information
			global.ircNotify("I tried to determine the correct order to build recipes in, but " +
				"\u0003" + IRC.rawColors.lightRed + "," + IRC.rawColors.black + "an exception occured" +
				IRC.colors.reset + " :/. Can someone check the logfiles and figure out why?");
		}
	};

	/**
	  * @public
	  * @memberof! RepositoryManager.prototype
	  * @description Creates jobs to build outdated ports.
	  */
	this.buildPorts = function () {
		for (var i in arches) {
			var graph = this._dependencyGraphFor(arches[i][0], arches[i][1]);
			if (graph === undefined)
				continue; // exception occured
			var build = {
				description: 'build new/updated recipes for ' + arches[i][0],
				architecture: arches[i][0],
				steps: [],
				appendJobsFlag: true,
				handleResult: function (step, exitcode, output) {
					if (exitcode !== 0) {
						step.status = 'failed';
						var recipeName = step.command.split(' ')[2],
							deps = graph.dependantsOf(recipeName);
						for (var i in deps) {
							for (var j in build.steps) {
								var stepAt = build.steps[j];
								if (stepAt.command.split(' ')[2] == deps[i])
									stepAt.status = 'failed';
								else if (stepAt.command === undefined)
									break; // we're past the end of the main steps now
							}
						}
					}
					return true;
				},
				onSuccess: function () {
					// This fires after the files are transferred (which happens below)

				}
			};
			var recipes = graph.overallOrder();
			for (var j in recipes) {
				var command = 'haikuporter --no-dependencies ' + recipes[j];
				if (recipes[j].indexOf(arches[i][1]) != -1)
					command += ' --no-source-packages';
				build.steps.push({command: command});
			}
			build.steps.push({action: function (callback) {
				// transfer files
				var filesToTransfer = [];
				for (var i in build.steps) {
					if (build.steps[i].status != 'succeeded')
						continue;
					var lines = build.steps[i].output.split('\n');
					for (var j in lines) {
						if (lines[j].indexOf('grabbing ') === 0) {
							filesToTransfer.push(lines[j].split(' ')[6]);
						}
					}
				}
				var transferredFiles = 0;
				for (var i in filesToTransfer) {
					builderManager.builders[build.builderName].transferFile(filesToTransfer[i],
						function (failed) {
							if (failed) {
								callback(999999999, 'Builder disconnected');
								return;
							}
							transferredFiles++;
							if (transferredFiles == filesToTransfer.length) {
								builderManager.builders[build.builderName].runCommand(
									'rm -rf ~/haikuports/packages/*',
									function (exitcode, output) {
										if (exitcode != 999999999)
											callback(0, '');
									});
							}
						});
				}
			}, command: 'transfer files'});
			buildsManager.addBuild(build);
		}
	};
};
