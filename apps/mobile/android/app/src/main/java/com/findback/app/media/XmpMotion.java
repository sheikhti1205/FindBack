package com.findback.app.media;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NamedNodeMap;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;
import org.xml.sax.helpers.DefaultHandler;

/** Namespace identity, not writer-selected prefixes, determines motion properties. */
final class XmpMotion {
    static final String CAMERA = "http://ns.google.com/photos/1.0/camera/";
    static final String CONTAINER = "http://ns.google.com/photos/1.0/container/";
    static final String ITEM = "http://ns.google.com/photos/1.0/container/item/";
    static final String RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
    enum Mode { NONE, DISABLED, LEGACY, MODERN }
    static final class Item {
        String mime, semantic, length, padding;
    }
    Mode mode = Mode.NONE;
    String offset;
    final List<Item> items = new ArrayList<>();
    static XmpMotion read(String header) {
        try {
            List<Element> nodes = parse(header);
            XmpMotion result = new XmpMotion();
            String flag = property(nodes, CAMERA, "MotionPhoto");
            if (flag != null && !flag.trim().matches("\\+?0*1")) { result.mode = Mode.DISABLED; return result; }
            boolean legacy = flag == null && "1".equals(property(nodes, CAMERA, "MicroVideo"));
            List<Element> dirs = matching(nodes, CONTAINER, "Directory");
            if (flag == null && !legacy) return result;
            if (flag == null && dirs.isEmpty()) {
                result.mode = Mode.LEGACY;
                result.offset = property(nodes, CAMERA, "MicroVideoOffset");
                return result;
            }
            if (dirs.size() != 1) throw invalid();
            List<Element> seq = matching(children(dirs.get(0)), RDF, "Seq");
            if (seq.size() != 1) throw invalid();
            List<Element> entries = children(seq.get(0));
            if (entries.size() < 2 || entries.size() > 16) throw invalid();
            for (Element entry : entries) {
                if (!is(entry, RDF, "li")) throw invalid();
                List<Element> resources = matching(children(entry), CONTAINER, "Item");
                if (resources.size() != 1) throw invalid();
                List<Element> fields = new ArrayList<>();
                walk(resources.get(0), fields);
                Item item = new Item();
                item.mime = property(fields, ITEM, "Mime");
                item.semantic = property(fields, ITEM, "Semantic");
                item.length = property(fields, ITEM, "Length");
                item.padding = property(fields, ITEM, "Padding");
                result.items.add(item);
            }
            result.mode = Mode.MODERN;
            return result;
        } catch (MediaPolicy.Failure e) { throw e; }
        catch (Exception e) { throw invalid(); }
    }
    private static MediaPolicy.Failure invalid() {
        return new MediaPolicy.Failure("Couldn't read the still frame of this motion photo. Try exporting a still JPEG.");
    }
    private static boolean is(Node node, String uri, String local) {
        return uri.equals(node.getNamespaceURI()) && local.equals(node.getLocalName());
    }
    private static List<Element> children(Element element) {
        List<Element> result = new ArrayList<>();
        for (Node node = element.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element) result.add((Element) node);
        }
        return result;
    }
    private static List<Element> matching(List<Element> nodes, String uri, String local) {
        List<Element> result = new ArrayList<>();
        for (Element element : nodes) if (is(element, uri, local)) result.add(element);
        return result;
    }
    private static void walk(Element element, List<Element> nodes) {
        if (nodes.size() >= 512) throw invalid();
        nodes.add(element);
        for (Element child : children(element)) walk(child, nodes);
    }
    private static String property(List<Element> nodes, String uri, String local) {
        List<String> values = new ArrayList<>();
        for (Element element : nodes) {
            if (is(element, uri, local)) values.add(element.getTextContent().trim());
            NamedNodeMap attrs = element.getAttributes();
            for (int i = 0; i < attrs.getLength(); i++) {
                Node attr = attrs.item(i);
                if (is(attr, uri, local)) values.add(attr.getNodeValue());
            }
        }
        if (values.size() > 1) throw invalid();
        return values.isEmpty() ? null : values.get(0);
    }
    private static List<Element> parse(String header) throws Exception {
        // DTD/entity declarations never reach the parser, including internal entities.
        if (header.contains("<!DOCTYPE") || header.contains("<!ENTITY")) throw invalid();
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setExpandEntityReferences(false);
        DocumentBuilder builder = factory.newDocumentBuilder();
        builder.setEntityResolver((publicId, systemId) -> { throw new SAXException("External XML entities disabled"); });
        builder.setErrorHandler(new DefaultHandler() {
            @Override public void error(SAXParseException error) throws SAXException { throw error; }
            @Override public void fatalError(SAXParseException error) throws SAXException { throw error; }
        });
        List<Element> result = new ArrayList<>();
        // Find complete root packets amidst JPEG segment bytes, not image-sized strings.
        Matcher roots = Pattern.compile("<([A-Za-z_][\\w:.-]*)(?:[^<>\"']|\"[^\"]*\"|'[^']*')*>").matcher(header);
        int from = 0;
        while (roots.find(from)) {
            int start = roots.start();
            String opening = roots.group();
            int end;
            if (opening.matches("[\\s\\S]*/\\s*>")) end = roots.end();
            else {
                String close = "</" + roots.group(1) + ">";
                int closing = header.indexOf(close, roots.end());
                if (closing < 0) throw invalid();
                end = closing + close.length();
            }
            String packet = header.substring(start, end);
            // Bound nesting before invoking a platform XML implementation.
            Matcher tags = Pattern.compile("</?[A-Za-z_][^>]*>").matcher(packet);
            int depth = 0;
            while (tags.find()) {
                String tag = tags.group();
                if (tag.startsWith("</")) depth--;
                else if (!tag.endsWith("/>")) depth++;
                if (depth > 32 || depth < 0) throw invalid();
            }
            walk(builder.parse(new InputSource(new StringReader(packet))).getDocumentElement(), result);
            from = end;
        }
        return result;
    }
}
