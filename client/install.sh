#!/bin/sh
#
# Copyright 2015 Haiku, Inc. All rights reserved.
# Distributed under the terms of the MIT License.
#
# Authors:
#		Augustin Cavalier <waddlesplash>

if [ ! -f "builder.conf" ]; then
	echo "'builder.conf' does not exist! Please create it."
	exit 1
fi

cp kitchen-client.template.sh kitchen-client.sh
sed -i s@WHEREVER_THE_DIR_IS@$(pwd)@ kitchen-client.sh
mv kitchen-client.sh ~/config/settings/boot/launch/
shutdown -r
