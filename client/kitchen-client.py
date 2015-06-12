#!/usr/bin/env python
#
# Copyright 2015 Haiku, Inc. All rights reserved.
# Distributed under the terms of the MIT License.
#
# Authors:
#		Augustin Cavalier <waddlesplash>

import os, sys, atexit, socket, ssl, json, subprocess, multiprocessing

confFilename = os.path.dirname(os.path.realpath(__file__)) + '/builder.conf'
if (not os.path.isfile(confFilename)):
	raise IOError("Configuration file '" + confFilename + "' does not exist!")

wantToExit = False
thisFile = __file__
def exit_handler():
	if (not wantToExit and (not hasattr(sys, 'last_type')
		or sys.last_type != KeyboardInterrupt)):
		# something happened (probably socket close?) so just restart
		print "Restarting process..."
		os.execv(thisFile, sys.argv)
atexit.register(exit_handler)

with open (confFilename, 'r') as confFile:
	try:
		conf = json.loads(confFile.read().replace('\n', ''))
	except ValueError:
		wantToExit = True
		print "Error: Your conf file is invalid JSON (filename: {0})".format(confFilename)
		sys.exit(1)

print "Connecting to {0}...".format(conf['ip'])
sock = socket.socket()
sock.setblocking(1)
sock.connect((conf['ip'], 42458))

def sendJSON(obj):
	"Writes the dictionary object passed to the socket as JSON."
	sock.send(json.dumps(obj, separators = (',',':')) + '\n')

sock = ssl.wrap_socket(sock, ssl_version = ssl.PROTOCOL_TLSv1,
					   cert_reqs = ssl.CERT_NONE)

authMsg = {'what': 'auth', 'name': conf['name'], 'key': conf['key']}
sock.recv(1) # wait until we recieve the first newline
sendJSON(authMsg)

dataBuf = ''
while True:
	while (not ('\n' in dataBuf)):
		newData = sock.recv(1024)
		if (not newData):
			print "Socket was closed."
			exit_handler()
		dataBuf += newData
	data = dataBuf.split('\n')
	dataBuf = data[-1]
	del data[-1]

	for rawMsg in data:
		reply = {}
		msg = json.loads(rawMsg)
		if (msg['what'] == 'command'):
			reply['what'] = msg['replyWith']
			reply['output'] = ''
			print "Executing command '" + msg['command'] + "'."
			proc = subprocess.Popen(msg['command'], shell = True,
									stdout = subprocess.PIPE,
									stderr = subprocess.STDOUT)
			for line in proc.stdout.readlines():
				reply['output'] += line
			reply['exitcode'] = proc.wait()
		elif (msg['what'] == 'getCores'):
			reply['what'] = 'coreCount'
			reply['count'] = multiprocessing.cpu_count()
		elif (msg['what'] == 'restart'):
			reply['what'] = 'restarting'
			print "Recieved message 'restart', restarting OS..."
			wantToExit = True
			subprocess.Popen('shutdown -r', shell = True)
		sendJSON(reply)
