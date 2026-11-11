"""Check an uploaded Office file (docx/xlsx/pptx) matches its source, allowing metadata SharePoint adds on upload.

Usage: verify-upload.py <source> <uploaded>   (exit 0 and "verified", or exit 1 with "ValueError: ...")
"""
import io
import posixpath
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile, BadZipFile


def compare(source, uploaded):
    a, b = ZipFile(io.BytesIO(source)), ZipFile(io.BytesIO(uploaded))
    if any(len(z.namelist()) != len(set(z.namelist())) for z in (a, b)):
        raise ValueError('Office payload differs: duplicate ZIP member')
    def metadata(z, name):
        return name == 'docProps/custom.xml' or name.startswith(('customXml/', '[trash]/'))

    def core(data):
        root = ET.fromstring(data)
        mutable = {
            '{http://purl.org/dc/terms/}modified',
            '{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}lastModifiedBy',
            '{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}revision',
        }
        for child in list(root):
            if child.tag in mutable:
                root.remove(child)
        def node(e):
            return (e.tag, tuple(sorted(e.attrib.items())), e.text if e.text and e.text.strip() else '',
                    tuple(sorted((node(c) for c in e), key=repr)))
        return node(root)
    def records(data):
        root = ET.fromstring(data)
        return {(e.tag, tuple(sorted(e.attrib.items()))) for e in root}
    differences = []
    for name in sorted(set(a.namelist()) | set(b.namelist())):
        if name in a.namelist() and name in b.namelist() and a.read(name) == b.read(name):
            continue
        if all(name not in z.namelist() or metadata(z, name) for z in (a, b)):
            continue
        if name == 'docProps/core.xml' and name in a.namelist() and name in b.namelist():
            if core(a.read(name)) == core(b.read(name)):
                continue
        if name in a.namelist() and name in b.namelist() and (name == '[Content_Types].xml' or name.endswith('.rels')):
            def relevant(z):
                result = set()
                for tag, attrs in records(z.read(name)):
                    d = dict(attrs)
                    if name == '[Content_Types].xml':
                        p = d.get('PartName', '').lstrip('/')
                        if p == 'docProps/custom.xml' or (p in z.namelist() and metadata(z, p)):
                            continue
                    elif d.get('Type', '').endswith(('/custom-properties', '/customXml', '/customXmlProps')):
                        parent = posixpath.dirname(posixpath.dirname(name))
                        target = posixpath.normpath(posixpath.join(parent, d.get('Target', '')))
                        if d.get('TargetMode') != 'External' and (target == 'docProps/custom.xml' or (target in z.namelist() and metadata(z, target))):
                            continue
                    result.add((tag, attrs))
                return result
            if relevant(a) == relevant(b):
                continue
        differences.append(name)
    if differences:
        raise ValueError('Office payload differs: ' + ', '.join(differences))
    return True


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    with open(argv[1], 'rb') as a, open(argv[2], 'rb') as b:
        source, uploaded = a.read(), b.read()
    try:
        compare(source, uploaded)
    except (ValueError, BadZipFile, ET.ParseError) as e:
        print(f'ValueError: {e}', file=sys.stderr)
        return 1
    print('verified')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
