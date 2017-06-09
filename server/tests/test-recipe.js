/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var Recipe = require('../recipe.js');

module.exports = {
	'generic-1.0.1': function (test) {
		var generic = new Recipe('recipe/generic-1.0.1.recipe');
		test.strictEqual(generic.name, 'generic');
		test.strictEqual(generic.version, '1.0.1');
		test.strictEqual(generic.revision, '1');
		test.strictEqual(JSON.stringify(generic.provides),
			JSON.stringify(['projectx = $portVersion', 'cmd:projectx = $portVersion']));
		test.strictEqual(JSON.stringify(generic.requires),
			JSON.stringify(['haiku']));
		test.strictEqual(JSON.stringify(generic.build_requires),
			JSON.stringify(['haiku_devel', 'cmd:make', 'cmd:gcc']));
		test.strictEqual(JSON.stringify(generic.architectures),
			JSON.stringify(['x86_gcc2', '?x86', '?x86_64']));
		test.done();
	},
	'generic_nogcc2-1.0.1': function (test) {
		var generic = new Recipe('recipe/generic_nogcc2-1.0.1.recipe');
		test.strictEqual(generic.name, 'generic_nogcc2');
		test.strictEqual(generic.version, '1.0.1');
		test.strictEqual(generic.revision, '1');
		test.strictEqual(JSON.stringify(generic.architectures),
			JSON.stringify(['x86', '?x86_64', '!x86_gcc2']));
		test.strictEqual(JSON.stringify(generic.secondaryArchitectures),
			JSON.stringify(['x86']));
		test.done();
	},
	'qemacs-0.3.3': function (test) {
		// This recipe has #s in the PROVIDES/REQUIRES
		var qemacs = new Recipe('recipe/qemacs-0.3.3.recipe');
		test.strictEqual(qemacs.name, 'qemacs');
		test.strictEqual(qemacs.version, '0.3.3');
		test.strictEqual(qemacs.revision, '1');
		test.strictEqual(JSON.stringify(qemacs.provides),
			JSON.stringify(['qemacs$secondaryArchSuffix = $portVersion',
				'app:qemacs$secondaryArchSuffix = $portVersion',
				'cmd:qemacs$secondaryArchSuffix = $portVersion',
				'cmd:qe$secondaryArchSuffix = $portVersion',
				'cmd:html2png$secondaryArchSuffix = $portVersion']));
		test.strictEqual(JSON.stringify(qemacs.requires),
			JSON.stringify(['haiku$secondaryArchSuffix',
				'lib:libpng$secondaryArchSuffix',
				'lib:libjpeg$secondaryArchSuffix']));
		test.done();
	},
	'clang-3.5.1': function (test) {
		// This recipe won't parse properly if stuff in {}s isn't ignored.
		var clang = new Recipe('recipe/clang-3.5.1.recipe');
		test.strictEqual(clang.name, 'clang');
		test.strictEqual(clang.version, '3.5.1');
		test.strictEqual(JSON.stringify(clang.requires),
			JSON.stringify(['haiku$secondaryArchSuffix',
				'lib:libstdc++$secondaryArchSuffix',
				'clang$secondaryArchSuffix == $portVersion base']));
		test.done();
	}
};
