## Introduction

The purpose of this project is to investigate existing solutions and technologies to create an interoperable web application to visualize 3D models of buildings and interact with them. The application should be able to display environmental data from sensors placed in the building in numerous ways (e.g., charts, tables, heatmaps, etc.).

## Existing solutions

### File formats

To share information about buildings, several file formats have been developed, most of them being proprietary (e.g., Revit, AutoCAD, ArchiCAD) and therefore not suitable for this project. There are however some open-source formats:

#### GbXML

Green Building XML (gbXML) is an open schema developed to facilitate the transfer of building data stored in CAD-based building information models (BIM) to engineering analysis tools and mainly used for energy analysis. It is based on XML and the relationships between building elements is represented using a tree structure. As gbXML can only represent rectagular shapes and does not support complex geometries, it is often used in conjunction with other file formats, such as IFC.

#### IFC

The Industry Foundation Classes (IFC) is a standardized and open file format developed by buildingSMART in order to facilitate interoperability in the AEC industry. It is a comprehensive schema that defines how building elements and their relationships should be represented in a digital model. IFC files can be used to store information about various aspects of a building, including its geometry, materials, properties, and relationships between different elements.

#### Performance

When dealing with large models, containing an important number of elements, performance can be an issue. While IFC files are excellent at storing information about relations between elements of a building, they are not optimized for rendering performance. That is why some file formats where created, optimized for 3D rendering:

- **glTF** (GL Transmission Format): [`glTF`](https://www.khronos.org/gltf/) is an open standard file format for 3D models and scenes, developed by the Khronos Group. It is designed to be efficient and easy to use, making it a popular choice for web applications and real-time rendering. However, glTF does not support the rich metadata and relationships between building elements that IFC provides, which can be a limitation when working with BIM data.
- **VIM**: [`VIM format`](https://github.com/vimaec/vim-format) is an open-source file format which has been developed load extremely large AEC models with high performance. It is now maintained by [`VIMAEC`](https://www.vimaec.com). The two reasons why VIM format was not considered for this project are that during the testing phase, spaces / rooms were not exported (even if the documentation says it should be supported) and that the converter from IFC (or Revit) files to VIM is a [proprietary software](https://docs.vimaec.com/docs/vim-for-developers/vim-for-developers).
- **Fragment**: [`Fragment`](https://docs.thatopen.com/fragments/schema) is a binary file format developed by `ThatOpenCompany` based on [`Flatbuffer`](https://flatbuffers.dev/) file format, which is an open-source serializing library orginally developed by Google. Using this file format, `ThatOpenCompany` libraries are more performant when it comes to load and display large IFC models. ⚠️ It is not possible to edit the Fragment files directly, [at the moment](#check-for-updates-concerning-engine_fragment-edit-apis), so if the model needs to be updated using the web application, the IFC file should be updated using another library (e.g., [`IfcOpenShell`](https://ifcopenshell.org/)) and then converted again to Fragment format.

### Web graphics

Although it is possible to create graphics in a web application using HTML, CSS and JavaScript, these technologies are not designed for high-performance graphics rendering. It is why WebGL has been developped. WebGL is a JavaScript API that allows to render 2D and 3D graphics in a web browser and using the GPU of the device to accelerate the rendering process and therefore improve the performance.

WebGL is a low-level API, which often means that it requires a good understanding of computer graphics and programming to use it effectively. To simplify the development process, [several high-level libraries and frameworks](https://gist.github.com/dmnsgn/76878ba6903cf15789b712464875cfdc) have been built on top of WebGL notably `Three.js`.

[Here is a comparison of some of the most popular WebGL-based libraries and frameworks for 3D graphics in web applications.](WebLibraryComparison.md)

#### Three.js

Three.js is a popular open-source JavaScript library that provides a high-level abstraction for creating and rendering 3D graphics in a web browser using WebGL. It simplifies the process of creating complex 3D scenes by providing a set of pre-built objects, materials, lights, and cameras that can be easily manipulated and combined to create rich 3D experiences.

There are also several libraries build on top of `Three.js` to provide additional features and tools for specific use cases, such as [`React Three Fiber`](https://github.com/pmndrs/react-three-fiber) which allows to use `Three.js` in a React application or [`Ifc.js`](https://github.com/ThatOpen/web-ifc-three) which provides tools to work with IFC files in a web application.

#### Ifc.js and ThatOpenCompany's libraries

[`Ifc.js`](https://github.com/ThatOpen/web-ifc-three) is a, now deprecated, open-source JavaScript library that allows to import, parse and visualize IFC files in a web browser using `Three.js`. It provides a set of tools and functions to work with IFC files, such as loading and parsing the files, creating 3D geometries from the IFC data, and rendering the geometries in a web browser.

The project has been replaced by two libraries, both developed by [ThatOpenCompany](https://github.com/ThatOpen):
- [`engine_web-ifc`](https://github.com/ThatOpen/engine_web-ifc): A library to load and parse IFC files in a web application, providing tools to work with the IFC data.
- [`engine_components`](https://github.com/ThatOpen/engine_components): A library based on `engine_web-ifc` but also providing a set of pre-built components and tools to create 3D scenes and applications.

`engine_components` is one of the three main ThatOpenCompany's libraries, the two others being [`engine_fragment`](https://github.com/ThatOpen/engine_fragment) and [`engine_ui-components`](https://github.com/ThatOpen/engine_ui-components). Altogether, these three libraries provide a powerful set of tools to create web applications that focus on displaying 3D models and view model's items properties.