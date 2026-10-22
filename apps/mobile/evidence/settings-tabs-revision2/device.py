"""Bounded native UI actions for the explicitly selected leased emulator."""
import sys, subprocess, re, time, xml.etree.ElementTree as ET
from pathlib import Path
import os
serial=os.environ.get('SERIAL','emulator-5554')
def adb(*args): return subprocess.check_output(['adb','-s',serial,*args],timeout=30)
def nodes():
    adb('shell','uiautomator','dump','/sdcard/rev2.xml')
    return list(ET.fromstring(adb('shell','cat','/sdcard/rev2.xml')).iter('node'))
action=sys.argv[1]
if action=='inspect':
    print([(n.get('text') or n.get('content-desc'),n.get('bounds')) for n in nodes() if n.get('text') or n.get('content-desc')])
elif action=='tap':
    label=sys.argv[2]
    matches=[n for n in nodes() if label in [n.get('text'),n.get('content-desc'),n.get('resource-id')]]
    assert matches, label
    x1,y1,x2,y2=map(int,re.findall(r'\d+',matches[0].get('bounds')))
    adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2));time.sleep(.4)
elif action=='shot':
    Path(__file__).with_name(sys.argv[2]+'.png').write_bytes(adb('exec-out','screencap','-p'))
