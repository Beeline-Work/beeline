from pathlib import Path
out=Path(__file__).parent/'assets'
ink='#352c28'
for name,color in [('alan','#bc845a'),('jimmy','#fff7e9'),('grok','#ef985c'),('codex','#b5b5e2'),('claude','#c7a67c'),('hermes','#f5cd53')]:
    parts=[]
    if name=='alan': parts += ['<circle cx="55" cy="55" r="24"/>','<circle cx="145" cy="55" r="24"/>']
    if name=='jimmy': parts += ['<ellipse cx="72" cy="42" rx="19" ry="38" transform="rotate(-12 72 42)"/>','<ellipse cx="127" cy="39" rx="19" ry="37" transform="rotate(13 127 39)"/>']
    if name in ('codex','grok','claude'): parts += ['<path d="M43 77 L39 24 Q65 25 85 58 M115 58 Q140 25 162 24 L158 80"/>']
    parts += ['<ellipse cx="100" cy="163" rx="49" ry="31"/>','<ellipse cx="60" cy="187" rx="23" ry="12"/>','<ellipse cx="140" cy="187" rx="23" ry="12"/>','<path d="M52 144 Q15 156 28 174 Q42 180 61 166 M148 144 Q184 131 183 151 Q176 168 151 169"/>','<rect x="29" y="52" width="142" height="113" rx="56"/>']
    if name=='alan': parts += ['<ellipse cx="100" cy="126" rx="32" ry="23" fill="#f2d8b9" stroke="none"/>']
    if name=='grok': parts += ['<path d="M31 106 Q60 109 100 141 Q141 109 170 106 Q170 165 100 165 Q29 163 31 106" fill="#fff5df" stroke="none"/>']
    if name=='claude': parts += ['<ellipse cx="72" cy="109" rx="32" ry="37" fill="#fff2dd" stroke="none"/>','<ellipse cx="128" cy="109" rx="32" ry="37" fill="#fff2dd" stroke="none"/>']
    if name=='hermes': parts += ['<path d="M88 53 Q71 28 92 31 Q105 36 106 51 Q122 28 129 40" fill="#f5cd53"/>']
    parts += [f'<ellipse cx="56" cy="123" rx="11" ry="6" fill="#ed9c92" stroke="none" opacity=".8"/>',f'<ellipse cx="145" cy="123" rx="11" ry="6" fill="#ed9c92" stroke="none" opacity=".8"/>']
    if name=='codex': parts += ['<path d="M64 108 L77 113 L64 118 M135 108 L122 113 L135 118" fill="none" stroke-width="5"/>','<path d="M92 134 Q100 142 108 134" fill="none"/>']
    else: parts += [f'<ellipse cx="73" cy="110" rx="4" ry="6" fill="{ink}" stroke="none"/>',f'<ellipse cx="127" cy="110" rx="4" ry="6" fill="{ink}" stroke="none"/>']
    if name=='hermes': parts += ['<ellipse cx="100" cy="130" rx="23" ry="11" fill="#e58c40"/>']
    elif name=='claude': parts += ['<path d="M93 125 L100 137 L107 125 Z" fill="#eab359"/>']
    elif name!='codex': parts += [f'<ellipse cx="100" cy="122" rx="7" ry="5" fill="{ink}" stroke="none"/>','<path d="M91 134 Q100 143 109 134" fill="none"/>']
    if name=='jimmy': parts += ['<rect x="117" y="153" width="25" height="33" rx="5" fill="#5a6673"/>','<path d="M124 160 H135" stroke="#fff7e9" stroke-width="2"/>']
    if name=='codex': parts += ['<path d="M54 137 L40 132 M54 145 L38 145 M147 137 L162 132 M147 145 L164 145" stroke-width="3"/>']
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 210" role="img"><title>{name} — original animal sticker</title><g fill="{color}" stroke="{ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">'+''.join(parts)+'</g></svg>'
    (out/(name+'.svg')).write_text(svg)
