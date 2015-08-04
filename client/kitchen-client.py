#!/usr/bin/env python
#
# Copyright 2015 Haiku, Inc. All rights reserved.
# Distributed under the terms of the MIT License.
#
# Authors:
#		Augustin Cavalier <waddlesplash>

import os, sys, socket, time, ssl, json, base64, subprocess, multiprocessing

confFilename = os.path.dirname(os.path.realpath(__file__)) + '/builder.conf'
if (not os.path.isfile(confFilename)):
	raise IOError("Configuration file '" + confFilename + "' does not exist!")

with open (confFilename, 'r') as confFile:
	try:
		conf = json.loads(confFile.read().replace('\n', ''))
	except ValueError:
		print "Error: Your conf file is invalid JSON (filename: {0})".format(confFilename)
		sys.exit(1)

print "Connecting to {0}...".format(conf['ip'])
sock = None
while True: # loop until we connect
	try:
		sock = socket.socket()
		sock.setblocking(1)
		sock.connect((conf['ip'], 42458))
	except:
		sock.close()
		time.sleep(5)
		continue
	break

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
			os.execv(__file__, sys.argv)
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
				sys.stdout.write(":: " + line)
				sys.stdout.flush()
			reply['exitcode'] = proc.wait()
		elif (msg['what'] == 'transferFile'):
			print "Transferring file '" + msg['file'] + "'."
			starting = {}
			starting['what'] = 'transferStarting'
			starting['id'] = msg['replyWith']
			sendJSON(starting)

			file = open(os.path.expanduser(msg['file']), 'rb')
			while True:
				piece = file.read(1024)
				if not piece:
					break
				sendJSON({'data': base64.b64encode(piece)})
			file.close()

			print "File transfer complete."
			reply['what'] = 'ignore'
		elif (msg['what'] == 'getCores'):
			reply['what'] = 'coreCount'
			reply['count'] = multiprocessing.cpu_count()
		elif (msg['what'] == 'restart'):
			reply['what'] = 'restarting'
			print "Recieved message 'restart', restarting OS..."
			subprocess.Popen('shutdown -r', shell = True)
		sendJSON(reply)
