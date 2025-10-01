# State of art

## Literature review

## Existing solutions

### APS

APS (Autodesk Platform Services) is a cloud-based developer platform which offers API for developer to create applications, integrations and extensions around Autodesk solutions. To create a digital twin web platform to visualize buildings, APS main advantage is the ability to interact with Autodesk’s solutions that are mainly designed towards the AEC field. Furthermore, they provide a web viewer SDK API, which is a powerful tool to visualize 2D and 3D models in a web application.
However, APS, like most of APS solutions is proprietary software and is not open-source. Also, APS stores the models and the data related to them by using Autodesk's cloud storage service OSS which itself use Amazon's solution, AWS S3. This means that the data is stored on Autodesk's servers, which may raise concerns about data privacy.

### Unity

Unity is a 

### Blender with Bonsai add-on

## File formats

### IFC

### gbXML

### VIM

## Web graphics

Although it is possible to create graphics in a web application using HTML, CSS and JavaScript, these technologies are not designed for high-performance graphics rendering. It is why WebGL has been developped. WebGL is a JavaScript API that allows to render 2D and 3D graphics in a web browser and using the GPU of the device to accelerate the rendering process and therefore improve the performance.

WebGL is a low-level API, which means that it provides a set of basic functions for rendering graphics, but it does not provide high-level abstractions or tools for creating complex graphics. To simplify the development process, [several libraries and frameworks](https://gist.github.com/dmnsgn/76878ba6903cf15789b712464875cfdc) have been built on top of WebGL, such as Three.js.

### Three.js

Three.js is a popular open-source JavaScript library that provides a high-level abstraction for creating and rendering 3D graphics in a web browser using WebGL. It simplifies the process of creating complex 3D scenes by providing a set of pre-built objects, materials, lights, and cameras that can be easily manipulated and combined to create rich 3D experiences.

There are also several libraries build on top of Three.js to provide additional features and tools for specific use cases, such as [React Three Fiber](https://github.com/pmndrs/react-three-fiber) which allows to use Three.js in a React application or [Ifc.js](https://github.com/ThatOpen/web-ifc-three) which provides tools to work with IFC files in a web application.

### Ifc.js and ThatOpenCompany's libraries

[Ifc.js](https://github.com/ThatOpen/web-ifc-three) is a, now deprecated, open-source JavaScript library that allows to import, parse and visualize IFC files in a web browser using Three.js. It provides a set of tools and functions to work with IFC files, such as loading and parsing the files, creating 3D geometries from the IFC data, and rendering the geometries in a web browser.

The project has been replaced by two libraries, both developed by [ThatOpenCompany](https://github.com/ThatOpen):
- [engine_web-ifc](https://github.com/ThatOpen/engine_web-ifc): A library to load and parse IFC files in a web application, providing tools to work with the IFC data.
- [engine_components](https://github.com/ThatOpen/engine_components): A library based on engine_web-ifc but also providing a set of pre-built components and tools to create 3D scenes and applications. This library is one of the three main ThatOpenCompany's libraries, the two others being [engine_fragment](https://github.com/ThatOpen/engine_fragment) and [engine_ui-components](https://github.com/ThatOpen/engine_ui-components).

## Architecture

### Modularization

##

### Creating spaces in the 3D scene

According to [ThatOpenCompany's documentation](https://docs.thatopen.com/Tutorials/Fragments/Fragments/FragmentsModels/ModelInformation#-accessing-geometry-data:~:text=A%20key%20reason%20why%20a%20FragmentsModel%20is%20highly%20memory%2Defficient%20is%20that%20all%20BufferAttributes%20from%20the%20geometry%20in%20ThreeJS%20are%20removed%20after%20being%20used%20to%20render%20the%20model%20in%20the%20scene.), the engine_fragment library disposes of an object's Three.js attributes once it has been added to the scene. As a result, it becomes difficult to access an object's Three.js meshes through the engine_fragment library, since the spaces are first added to a tile and then removed.
To overcome this issue, the spaces are recreated using Three.js after the model has been loaded and added to the scene. We then store the meshes of each space in a map, which allows us to efficiently access and update their colors later based on sensor data.


```javascript
async function retrieveSpaces() {
    if (!model) return;

    // Clear previous spaces
    spaces.clear();

    // Get all spaces from the model
    const finder = components.get(OBC.ItemsFinder);
    const spacesItems = await finder.getItems([
        {
            categories: [/^IFCSPACE$/],
        }
    ]);

    // Function to create a Three.js mesh from geometry data
    const createMesh = (data: FRAGS.MeshData) => {
        const meshMaterial = new THREE.MeshLambertMaterial({ color: "white" });
        const { positions, indices, normals, transform } = data;
        if (!(positions && indices && normals)) return null;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
        geometry.setIndex(Array.from(indices));

        const mesh = new THREE.Mesh(geometry, meshMaterial);
        mesh.applyMatrix4(transform);
        return mesh;
    };

    const promises = [];

    // Create a mesh for each space
    for (const [modelId, localIds] of Object.entries(spacesItems)) {
        const model = fragments.list.get(modelId);

        if (!model) continue;

        // Retrieve space item data and geometry
        const spaceItemData = await model.getItemsData([...localIds]);
        const spaceItemGeometry = await model.getItemsGeometry([...localIds]);

        for (const [index, spaceData] of spaceItemData.entries()) {
            // Store space data in the spaces map
            spaces.set(spaceData._guid.value, {
                id: spaceData._guid.value,
                modelId,
                localId: spaceData._localId.value,
                geometries: spaceItemGeometry[index],
                meshes: spaceItemGeometry[index]?.map((geom) => createMesh(geom))
            });

            if (spaces.get(spaceData._guid.value).meshes)
                spaces.get(spaceData._guid.value).meshes.forEach(mesh => world.scene.three.add(mesh));
        }

        promises.push(model.setVisible([...localIds], false));
    }

    await Promise.all(promises);
}
```

### Updating space colors based on sensor data

The following UML sequence diagram illustrates the process of updating space colors in the 3D scene. When the current time is updated through the timeline component, it triggers a hook in the viewer component. The viewer then retrieves the new sensor values corresponding to the updated time from the sensor store. Finally, it updates the colors of the spaces in the 3D scene based on these new sensor values.

![UML sequence diagram showing the flow of updating space colors based on sensor data](./assets/images/colorSpaceSequenceDiagram.png)