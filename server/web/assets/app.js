/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var kArchitecture = ['x86', 'x86_64', 'x86_gcc2', 'arm', 'ppc'];
function getFriendlyNameForStatus(status) {
	if (status == 'pending')
		return 'queued';
	else if (status == 'running')
		return 'started';
	else
		return status;
}

/*! toggles the contents and spinner areas */
function hideContents() {
	$('#pageContents').hide();
	$('#loading-placeholder').show();
}
function showContents() {
	$('#loading-placeholder').hide();
	$('#pageContents').show();
}

/*! sets the page <title> and <div id='pageTitle'> */
function setPageTitle(title, description) {
	$('title').html(title + ' | Haiku Kitchen');
	$('#pageTitle h2').html(title);
	$('#pageTitle p').html(description);
}

function pageLoadingFailed(err) {
	if (err && err.status == 404)
		setPageTitle('404 Not Found', 'We can’t find that page! <i class="fa fa-frown-o"></i>');
	else
		setPageTitle('Ack!', 'Something went wrong! <i class="fa fa-frown-o"></i> Try reloading the page.');
	showContents();
}

function fetchPageAndCall(pageUrl, func) {
	$.ajax(pageUrl, {dataType: 'text'})
		.done(function (data) {
			func(data);
		})
		.fail(pageLoadingFailed);
}

function showHomePage(data) {
	setPageTitle('Home', '');
	$('#pageContentsBody').html(data);
	showContents();
}

function showRecipesPage(pageData) {
	$.ajax('/api/recipes')
		.done(function (data) {
			$('#pageContentsBody').html(pageData);

			for (var i in data) {
				var html =
					'<tr><td><i class="fa fa-file-text-o"></i> ' + data[i].name + '</td>' +
					'<td>' + data[i].category + '</td>' +
					'<td>' + data[i].version + '</td>' +
					'<td>' + data[i].revision + '</td><td>';
				if (data[i].lint === true)
					html += '<i class="fa fa-check-circle"></i><span>true</span>';
				else if (data[i].lint === false)
					html += '<i class="fa fa-times-circle"></i><span>false</span>';
				else
					html += '<i class="fa fa-question-circle"></i><span>?</span>';
				html += "</td>";
				for (var a in kArchitecture) {
					var arch = kArchitecture[a];
					html += "<td>";
					if (arch in data[i] && data[i][arch])
						html += '<a href="' + data[i][arch] + '"><i class="fa fa-archive"></i></a>';
					html += "</td>";
				}
				html += "</tr>";

				$("#recipesTableBody").append(html);
			}
			$("table.sortable").stupidtable();

			setPageTitle('Recipes', 'This is a complete listing of recipes known ' +
				'to the Haiku package build system:');
			showContents();
		})
		.fail(pageLoadingFailed);
}

function showBuildersPage() {
	$.ajax('/api/builders')
		.done(function (data) {
			var onlineBuilders = 0, totalBuilders = 0;
			for (var i in data) {
				totalBuilders++;
				var html =
					'<div class="builder"><span class="heading"> ' + i + ' ';
				if (data[i].status == 'online') {
					onlineBuilders++;
					html += '<i class="fa fa-check-circle-o"></i>';
				} else if (data[i].status == 'busy')
					html += '<i class="fa fa-dot-circle-o" style="color: orange;"></i>';
				else
					html += '<i class="fa fa-times-circle-o"></i>';
				html += '</span>&nbsp;&nbsp;<span>owner: ' +
						data[i].owner.replace(/<[^>]*>/g, '') + '<br>';
				if (data[i].status == 'online' || data[i].status == 'busy') {
					html += '<a href="https://cgit.haiku-os.org/haiku/commit/?id=hrev' +
							data[i].hrev + '">hrev' + data[i].hrev + '</a>, ' +
						data[i].cores + (data[i].cores > 1 ? ' cores' : ' core') + ', ' +
						data[i].flavor + ' ' + data[i].architecture + '</div>';
				}
				$("#pageContentsBody").append(html);
			}
			setPageTitle('Builders', "<b>" + onlineBuilders +
				"</b> builders are online out of <b>" + totalBuilders + "</b>.");
			showContents();
		})
		.fail(pageLoadingFailed);
}

function showBuildsPage() {
	$.ajax('/api/builds')
		.done(function (data) {
			$("#pageContentsBody").html('<table id="buildsTable"></table>');
			for (var i in data) {
				var row = '<tr class="status-' + data[i].status + '">';
				row += '<td><a href="#/build/' + data[i].id + '">#' +
					data[i].id + '</a></td>';
				row += '<td>' + data[i].description + '</td>';
				row += '<td>' + getFriendlyNameForStatus(data[i].status) +
					' ' + $.timeago(data[i].lastTime) + '</td>';
				row += '<td>' + data[i].steps + ' steps</td>';
				row += '</tr>';
				$("#buildsTable").append(row);
			}
			setPageTitle('Builds', '');
			showContents();
		})
		.fail(pageLoadingFailed);
}

function buildOutput(e) {
	e.preventDefault();
	var li = $(e.target.parentNode);
	li.toggleClass('outputVisible');
	if (li.hasClass('outputVisible'))
		$(e.target).html('hide');
	else
		$(e.target).html('output');
}
function showBuildPage(pageData) {
	$.ajax('/api/build/' + /[^/]*$/.exec(window.location.hash)[0])
		.done(function (data) {
			$('#pageContentsBody').html(pageData);

			$("#builderName").text(data.builder);
			$("#statusName").text(getFriendlyNameForStatus(data.status));
			$("#buildStatus").addClass('status-' + data.status);
			$("#lastTime").text($.timeago(data.lastTime));

			if (data.status == 'running') {
				$("#duration").hide();
				$("#builtOrBuilding").text('building on');
			} else {
				var duration = (new Date(data.lastTime).getTime() -
						new Date(data.startTime).getTime()), durStr = '',
					hours = Math.floor(duration / 1000 / 60 / 60);
				duration -= hours * 1000 * 60 * 60;
				var min = Math.floor(duration / 1000 / 60);
				duration -= min * 1000 * 60;
				var sec = Math.floor(duration / 1000);
				if (hours > 0)
					durStr += hours + ' hours, ';
				if (min > 0)
					durStr += min + ' minutes';
				else if (sec > 0)
					durStr += sec + ' seconds';
				$("#durationText").text(durStr);
			}

			for (var i in data.steps) {
				var status, step = data.steps[i];
				var didThisStep = false;
				if (data.status == 'succeeded' || data.curStep > i) {
					status = 'succeeded';
					didThisStep = true;
				} else if (data.curStep == i) {
					if (data.status == 'failed')
						status = 'failed';
					else
						status = 'running';
				} else
					status = 'pending';
				var item = '<li class="status-' + status + '">';
				item += step.command;
				if (didThisStep) {
					item += '<a href="#" onclick="buildOutput(event);">output</a>';
					item += '<div class="textarea">' +
						step.output
							.replace(/&/g, '&amp;')
							.replace(/</g, '&lt;')
							.replace(/>/g, '&gt;')
							.replace(/\r*\n/g, '<br>') +
						'<br><span>Command exited with code ' + step.exitcode + '.</span>' +
						'</div>';
				}
				item += '</li>';
				$("#buildSteps").append(item);
			}

			setPageTitle('Build #' + data.id, data.description);
			showContents();
		})
		.fail(pageLoadingFailed);
}

var currentHash = '';
function navigate(force) {
	if (currentHash == window.location.hash && !force)
		return;

	hideContents();
	$('#menu li').removeClass('active');
	$('#pageContentsBody').html('');
	setPageTitle('Loading…', '');

	if (window.location.hash.indexOf("#/build/") == 0) {
		fetchPageAndCall('pages/build.html', showBuildPage);
		currentHash = window.location.hash;
		return;
	}
	switch (window.location.hash) {
	case '':
	case '#/':
		fetchPageAndCall('pages/home.html', showHomePage);
		break;
	case '#/recipes':
		$('#menu li.recipes').addClass('active');
		fetchPageAndCall('pages/recipes.html', showRecipesPage);
		break;
	case '#/builders':
		$('#menu li.builders').addClass('active');
		showBuildersPage();
		break;
	case '#/builds':
		$('#menu li.builds').addClass('active');
		showBuildsPage();
		break;

	default:
		pageLoadingFailed({status: 404});
		currentHash = '';
		return;
	}
	currentHash = window.location.hash;
}

$(window).on('hashchange', function() {
	navigate();
});
$(function () {
	$.timeago.settings.allowFuture = true;
	navigate(true);
});
