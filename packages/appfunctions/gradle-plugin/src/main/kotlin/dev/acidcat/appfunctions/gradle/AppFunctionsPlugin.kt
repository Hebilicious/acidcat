/*
 * The Gradle plugin `dev.acidcat.appfunctions`: generate the AppFunctions service of an Android app from its catalog, at
 * build time (spec/catalog.md#build-time-and-run-time).
 */
package dev.acidcat.appfunctions.gradle

import com.android.build.api.variant.AndroidComponentsExtension
import dev.acidcat.core.AcidCatJson
import kotlinx.serialization.json.JsonObject
import org.gradle.api.DefaultTask
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/** The settings of the plugin, in the block `acidCatAppFunctions { … }`. */
public abstract class AppFunctionsExtension {
    /** The catalog file of the application, in canonical form. */
    public abstract val catalog: RegularFileProperty

    /** The target whose view the app functions serve. */
    public abstract val target: Property<String>

    /** The package of the generated code. */
    public abstract val packageName: Property<String>

    /** The name of the service class. The default is `AcidCatAppFunctionService`. */
    public abstract val serviceName: Property<String>

    /** The fully qualified name of the `object` that implements `dev.acidcat.appfunctions.AppFunctionsProvider`. */
    public abstract val provider: Property<String>
}

/** The inputs of the generator. Each task writes one kind of output, as the Android Gradle plugin needs. */
public abstract class GeneratorTask : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    public abstract val catalog: RegularFileProperty

    @get:Input
    public abstract val target: Property<String>

    @get:Input
    public abstract val packageName: Property<String>

    @get:Input
    public abstract val serviceName: Property<String>

    @get:Input
    public abstract val provider: Property<String>

    /** The generated files of the catalog. */
    protected fun generated(): Generated {
        val file = catalog.get().asFile
        val catalog = AcidCatJson.parseToJsonElement(file.readText()) as? JsonObject
            ?: throw IllegalArgumentException("${file.path} is not a catalog: it is not a JSON object.")
        return generate(catalog, GeneratorSettings(target.get(), packageName.get(), serviceName.get(), provider.get()))
    }

    internal fun configure(extension: AppFunctionsExtension) {
        catalog.set(extension.catalog)
        target.set(extension.target)
        packageName.set(extension.packageName)
        serviceName.set(extension.serviceName)
        provider.set(extension.provider)
    }
}

/** Generate the Kotlin sources of the app functions of the view of a target. */
@CacheableTask
public abstract class GenerateAppFunctions : GeneratorTask() {
    @get:OutputDirectory
    public abstract val sourceDirectory: DirectoryProperty

    @TaskAction
    public fun generate() {
        val sources = sourceDirectory.get().asFile
        sources.deleteRecursively()
        generated().sources.forEach { (path, text) -> sources.resolve(path).apply { parentFile.mkdirs() }.writeText(text) }
    }
}

/** Generate the resource of the app metadata: the description of the catalog, as the instructions for an agent. */
@CacheableTask
public abstract class GenerateAppFunctionsResources : GeneratorTask() {
    @get:OutputDirectory
    public abstract val resourceDirectory: DirectoryProperty

    @TaskAction
    public fun generate() {
        val resources = resourceDirectory.get().asFile
        resources.deleteRecursively()
        resources.mkdirs()
        generated().appMetadata?.let { resources.resolve("xml/acidcat_app_metadata.xml").apply { parentFile.mkdirs() }.writeText(it) }
    }
}

/** Generate the manifest that declares the service. */
@CacheableTask
public abstract class GenerateAppFunctionsManifest : GeneratorTask() {
    @get:OutputFile
    public abstract val manifestFile: RegularFileProperty

    @TaskAction
    public fun generate() {
        manifestFile.get().asFile.apply { parentFile.mkdirs() }.writeText(generated().manifest)
    }
}

/** Registers [GenerateAppFunctions] for each variant of an Android app or library, and adds its output to the variant. */
public class AppFunctionsPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create("acidCatAppFunctions", AppFunctionsExtension::class.java)
        extension.serviceName.convention("AcidCatAppFunctionService")
        for (android in listOf("com.android.application", "com.android.library")) {
            project.pluginManager.withPlugin(android) {
                val components = project.extensions.getByType(AndroidComponentsExtension::class.java)
                components.onVariants { variant ->
                    val prefix = "generate${variant.name.replaceFirstChar { it.uppercaseChar() }}AcidCatAppFunctions"
                    val sources = project.tasks.register(prefix, GenerateAppFunctions::class.java) { task ->
                        task.description = "Generate the AppFunctions service of the ${variant.name} variant from the catalog."
                        task.configure(extension)
                    }
                    val resources = project.tasks.register("${prefix}Resources", GenerateAppFunctionsResources::class.java) { task ->
                        task.description = "Generate the app metadata of the ${variant.name} variant from the catalog."
                        task.configure(extension)
                    }
                    val manifest = project.tasks.register("${prefix}Manifest", GenerateAppFunctionsManifest::class.java) { task ->
                        task.description = "Generate the manifest of the service of the ${variant.name} variant."
                        task.configure(extension)
                        task.manifestFile.set(project.layout.buildDirectory.file("generated/acidcat/${variant.name}/AndroidManifest.xml"))
                    }
                    variant.sources.kotlin?.addGeneratedSourceDirectory(sources, GenerateAppFunctions::sourceDirectory)
                    variant.sources.res?.addGeneratedSourceDirectory(resources, GenerateAppFunctionsResources::resourceDirectory)
                    variant.sources.manifests.addGeneratedManifestFile(manifest, GenerateAppFunctionsManifest::manifestFile)
                }
            }
        }
    }
}
