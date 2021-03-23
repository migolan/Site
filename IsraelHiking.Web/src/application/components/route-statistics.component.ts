import { Component, ViewEncapsulation, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef } from "@angular/core";
import { trigger, style, transition, animate } from "@angular/animations";
import { Subscription, Observable, interval } from "rxjs";
import { NgxD3Service, Selection, BaseType, ScaleContinuousNumeric } from "@katze/ngx-d3";
import { regressionLoess } from "d3-regression";

import { BaseMapComponent } from "./base-map.component";
import { SelectedRouteService } from "../services/layers/routelayers/selected-route.service";
import { ResourcesService } from "../services/resources.service";
import { RouteStatisticsService, IRouteStatistics, IRouteStatisticsPoint } from "../services/route-statistics.service";
import { CancelableTimeoutService } from "../services/cancelable-timeout.service";
import { SidebarService } from "../services/sidebar.service";
import { SpatialService } from "../services/spatial.service";
import { GeoLocationService } from "../services/geo-location.service";
import { AudioPlayerFactory, IAudioPlayer } from "../services/audio-player.factory";
import { select, NgRedux } from "../reducers/infra/ng-redux.module";
import { LatLngAlt, RouteData, ApplicationState, Language } from "../models/models";

declare type DragState = "start" | "drag" | "none";

interface IMargin {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

interface IChartSubRouteRange {
    xStart: number;
    xEnd: number;
}

interface IChartElements {
    svg: Selection<any, {}, null, undefined>;
    chartArea: Selection<SVGGElement, {}, null, undefined>;
    path: Selection<SVGPathElement, {}, null, undefined>;
    hoverGroup: Selection<BaseType, {}, null, undefined>;
    dragRect: Selection<SVGRectElement, {}, null, undefined>;
    locationGroup: Selection<BaseType, {}, null, undefined>;
    xScale: ScaleContinuousNumeric<number, number>;
    yScale: ScaleContinuousNumeric<number, number>;
    yScaleSlope: ScaleContinuousNumeric<number, number>;
    margin: IMargin;
    width: number;
    height: number;
    dragState: DragState;
}

@Component({
    selector: "route-statistics",
    templateUrl: "./route-statistics.component.html",
    styleUrls: ["./route-statistics.component.scss"],
    encapsulation: ViewEncapsulation.None,
    animations: [
        trigger("animateChart", [
            transition(
                ":enter", [
                style({ transform: "scale(0.2)", "transform-origin": "bottom right" }),
                animate("200ms", style({ transform: "scale(1)", "transform-origin": "bottom right" }))
            ]
            ),
            transition(
                ":leave", [
                style({ transform: "scale(1)", "transform-origin": "bottom right" }),
                animate("200ms", style({ transform: "scale(0.2)", "transform-origin": "bottom right" }))
            ]
            )]
        )
    ],
})
export class RouteStatisticsComponent extends BaseMapComponent implements OnInit, OnDestroy {
    private static readonly HOVER_BOX_WIDTH = 160;

    public length: number;
    public gain: number;
    public loss: number;
    public duration: string;
    public durationUnits: string;
    public averageSpeed: number;
    public currentSpeed: number;
    public remainingDistance: number;
    public ETA: string;
    public isKmMarkersOn: boolean;
    public isSlopeOn: boolean;
    public isExpanded: boolean;
    public isTable: boolean;
    public isOpen: boolean;
    public isFollowing: boolean;
    public kmMarkersSource: GeoJSON.FeatureCollection<GeoJSON.Point>;
    public chartHoverSource: GeoJSON.FeatureCollection<GeoJSON.Point>;
    public subRouteRange: IChartSubRouteRange;

    @ViewChild("lineChartContainer")
    public lineChartContainer: ElementRef;

    @select((state: ApplicationState) => state.routes.present)
    private routes$: Observable<RouteData[]>;

    @select((state: ApplicationState) => state.routeEditingState.selectedRouteId)
    private selectedRouteId$: Observable<string>;

    @select((state: ApplicationState) => state.location.zoom)
    private zoom$: Observable<number>;

    @select((state: ApplicationState) => state.uiComponentsState.statisticsVisible)
    public statisticsVisible$: Observable<boolean>;

    @select((state: ApplicationState) => state.configuration.language)
    public language$: Observable<Language>;

    private statistics: IRouteStatistics;
    private chartElements: IChartElements;
    private componentSubscriptions: Subscription[];
    private zoom: number;
    private routeColor: string;
    private audioPlayer: IAudioPlayer;

    constructor(resources: ResourcesService,
                private readonly changeDetectorRef: ChangeDetectorRef,
                private readonly d3Service: NgxD3Service,
                private readonly selectedRouteService: SelectedRouteService,
                private readonly routeStatisticsService: RouteStatisticsService,
                private readonly cancelableTimeoutService: CancelableTimeoutService,
                private readonly sidebarService: SidebarService,
                private readonly geoLocationService: GeoLocationService,
                private readonly audioPlayerFactory: AudioPlayerFactory,
                private readonly ngRedux: NgRedux<ApplicationState>
    ) {
        super(resources);
        this.isKmMarkersOn = false;
        this.isSlopeOn = false;
        this.isExpanded = false;
        this.isOpen = false;
        this.isTable = false;
        this.isFollowing = false;
        this.statistics = null;
        this.subRouteRange = null;
        this.setViewStatisticsValues(null);
        this.componentSubscriptions = [];
        this.kmMarkersSource = {
            type: "FeatureCollection",
            features: []
        };
        this.chartHoverSource = {
            type: "FeatureCollection",
            features: []
        };
        this.chartElements = {
            margin: { top: 10, right: 10, bottom: 40, left: 40 },
        } as IChartElements;
        this.zoom = 7;
        this.zoom$.subscribe((zoom) => {
            this.zoom = zoom;
            this.updateKmMarkers();
        });
        this.componentSubscriptions.push(this.sidebarService.sideBarStateChanged.subscribe(() => {
            this.redrawChart();
        }));
        this.componentSubscriptions.push(this.selectedRouteService.selectedRouteHover.subscribe(this.onSelectedRouteHover));
    }

    private setViewStatisticsValues(statistics: IRouteStatistics): void {
        if (statistics == null) {
            this.length = 0;
            this.gain = 0;
            this.loss = 0;
            this.remainingDistance = 0;
            this.updateDurationString(null);
            this.currentSpeed = null;
            this.averageSpeed = null;
            this.ETA = "--:--";
        } else {
            this.length = statistics.length;
            this.gain = statistics.gain;
            this.loss = statistics.loss;
            this.remainingDistance = statistics.remainingDistance;
            this.averageSpeed = statistics.averageSpeed;
            this.updateDurationString(statistics.duration);
            this.updateETAString();
        }
    }

    private updateDurationString(duration: number) {
        if (!duration) {
            this.duration = "--:--";
            this.durationUnits = "";
        } else {
            const HOUR = 60 * 60;
            const MINUTE = 60;
            if (duration > HOUR) {
                let hours = Math.floor(duration / (HOUR));
                let minutes = Math.floor((duration % (HOUR)) / MINUTE);
                this.duration = this.toTwoDigits(hours) + ":" + this.toTwoDigits(minutes);
                this.durationUnits = this.resources.hourUnit;
            } else {
                let minutes = Math.floor(duration / MINUTE);
                let seconds = Math.floor(duration % MINUTE);
                this.duration = this.toTwoDigits(minutes) + ":" + this.toTwoDigits(seconds);
                this.durationUnits = this.resources.minuteUnit;
            }
        }
    }

    private updateETAString() {
        let speed = null;
        if (this.statistics.averageSpeed) {
            speed = this.statistics.averageSpeed;
        } else if (this.currentSpeed) {
            speed = this.currentSpeed;
        }
        if (speed && this.statistics.remainingDistance) {
            let timeLeftInMilliseconds = Math.floor(this.statistics.remainingDistance * 3600 / speed);
            let finishDate = new Date(new Date().getTime() + timeLeftInMilliseconds);
            this.ETA = finishDate.getHours().toString().padStart(2, "0") + ":" +
                finishDate.getMinutes().toString().padStart(2, "0");
        } else {
            this.ETA = "--:--";
        }
    }

    private toTwoDigits(value: number): string {
        let str = value.toString();
        if (str.length === 1) {
            str = `0${str}`;
        }
        return str;
    }

    public async ngOnInit() {
        this.componentSubscriptions.push(this.routes$.subscribe(() => {
            this.routeChanged();
        }));
        this.componentSubscriptions.push(this.selectedRouteId$.subscribe(() => {
            this.routeChanged();
        }));
        this.componentSubscriptions.push(this.language$.subscribe(() => {
            this.redrawChart();
        }));
        this.componentSubscriptions.push(this.geoLocationService.positionChanged.subscribe(p => {
            this.onGeolocationChanged(p);
        }));
        this.routeChanged();
        this.componentSubscriptions.push(interval(1000).subscribe(() => {
            let recordingRoute = this.selectedRouteService.getRecordingRoute();
            if (recordingRoute) {
                this.updateDurationString((new Date().getTime() - recordingRoute.segments[0].latlngs[0].timestamp.getTime()) / 1000);
            }
        }));
        this.audioPlayer = await this.audioPlayerFactory.create("content/uh-oh.mp3");
    }

    public ngOnDestroy() {
        for (let subscription of this.componentSubscriptions) {
            subscription.unsubscribe();
        }
    }

    public changeState(state: string) {
        switch (state) {
            case "table":
                if (this.isTable) {
                    this.toggle();
                } else {
                    this.isTable = true;
                }
                break;
            case "graph":
                if (!this.isTable) {
                    this.toggle();
                } else {
                    this.isTable = false;
                    this.redrawChart();
                }
        }
    }

    public isSidebarVisible() {
        return this.sidebarService.isSidebarOpen();
    }

    public getUnits = (value: number): string => {
        return Math.abs(value) > 1000 ? this.resources.kmUnit : this.resources.meterUnit;
    }

    public toShortNumber = (value: number): string => {
        if (value == null) {
            return "0";
        }
        return Math.abs(value) > 1000 ? (value / 1000.0).toFixed(2) : value.toFixed(0);
    }

    public toggle(): void {
        this.isOpen = !this.isOpen;
        if (this.isOpen) {
            this.redrawChart();
        } else {
            this.clearSubRouteSelection();
        }
    }

    private routeChanged() {
        this.updateKmMarkers();
        this.setDataToChart([]);
        this.hideLocationGroup();
        this.onRouteDataChanged();
    }

    private onRouteDataChanged = () => {

        this.updateStatistics();

        if (!this.getRouteForChart()) {
            return;
        }
        if (this.isOpen) {
            this.clearSubRouteSelection();
            this.setRouteColorToChart();
            this.setDataToChart(this.getDataFromStatistics());
            this.refreshLocationGroup();
        }
        this.updateKmMarkers();
    }

    public redrawChart = () => {
        this.changeDetectorRef.detectChanges();
        if (!this.isOpen) {
            return;
        }
        if (!this.lineChartContainer || !this.lineChartContainer.nativeElement) {
            return;
        }

        this.routeColor = "black";
        this.updateStatistics();
        this.initChart();
        this.createChartAxis();
        this.addChartPath();
        this.addChartDragGroup();
        this.addChartLocationGroup();
        this.addChartHoverGroup();
        this.addEventsSupport();
        // must be last
        this.setRouteColorToChart();
        this.setDataToChart(this.getDataFromStatistics());
        this.refreshLocationGroup();
        this.updateSubRouteSelectionOnChart();
    }

    private hideChartHover() {
        this.chartElements.hoverGroup.style("display", "none");
        this.chartHoverSource = {
            type: "FeatureCollection",
            features: []
        };
    }

    private showChartHover(point: IRouteStatisticsPoint) {
        if (!point) {
            this.hideChartHover();
            return;
        }
        let chartXCoordinate = this.chartElements.xScale(point.coordinate[0]);
        let chartYCoordinate = this.chartElements.yScale(point.coordinate[1]);
        this.chartElements.hoverGroup.style("display", null);
        this.chartElements.hoverGroup.attr("transform", `translate(${chartXCoordinate}, 0)`);
        this.chartElements.hoverGroup.selectAll("circle").attr("cy", chartYCoordinate);
        let safeDistance = 20;
        let boxPosition = safeDistance;
        if (chartXCoordinate > +this.chartElements.svg.attr("width") / 2) {
            boxPosition = -RouteStatisticsComponent.HOVER_BOX_WIDTH - safeDistance;
        }
        this.chartElements.hoverGroup.select("g").attr("transform", `translate(${boxPosition}, 0)`);
        this.buildAllTextInHoverBox(point);
        this.updatePointOnMap(point);
    }

    private updatePointOnMap(point: IRouteStatisticsPoint) {
        this.chartHoverSource = {
            type: "FeatureCollection",
            features: [{
                type: "Feature",
                properties: { color: this.routeColor },
                geometry: {
                    type: "Point",
                    coordinates: [point.latlng.lng, point.latlng.lat]
                }
            }]
        };
    }

    private onMouseDown = () => {
        this.chartElements.dragState = "start";
        let d3 = this.d3Service.getD3();
        this.subRouteRange = {
            xStart: this.chartElements.xScale.invert(d3.mouse(this.chartElements.chartArea.node())[0]),
            xEnd: null
        };
    }

    private onMouseMove = () => {
        let d3 = this.d3Service.getD3();
        d3.event.stopPropagation();
        let chartXCoordinate = d3.mouse(this.chartElements.chartArea.node())[0];
        let xPosition = this.chartElements.xScale.invert(chartXCoordinate);
        let point = this.routeStatisticsService.interpolateStatistics(this.statistics, xPosition);
        if (this.chartElements.dragState === "none") {
            this.showChartHover(point);
            this.updateSubRouteSelectionOnChart();
            return;
        }
        if (this.chartElements.dragState === "start") {
            this.chartElements.dragState = "drag";
        }
        if (this.chartElements.dragState === "drag") {
            this.subRouteRange.xEnd = xPosition;
            this.updateSubRouteSelectionOnChart();
            this.hideChartHover();
            this.updatePointOnMap(point);
        }

    }

    private onMouseUp() {
        if (this.chartElements.dragState === "drag") {
            this.chartElements.dragState = "none";
            return;
        }
        // click
        this.chartElements.dragState = "none";
        this.clearSubRouteSelection();
        const timeoutGroupName = "clickOnChart";
        this.cancelableTimeoutService.clearTimeoutByGroup(timeoutGroupName);
        this.cancelableTimeoutService.setTimeoutByGroup(() => {
            this.hideChartHover();
        },
            5000,
            timeoutGroupName);
    }

    private initChart() {
        let d3 = this.d3Service.getD3();
        this.chartElements.margin.right = this.isSlopeOn ? 30 : 10;
        this.chartElements.svg = d3.select(this.lineChartContainer.nativeElement).select("svg");
        this.chartElements.svg.html("");
        let windowStyle = window.getComputedStyle(this.lineChartContainer.nativeElement);
        let width = +windowStyle.width.replace("px", "");
        let height = +windowStyle.height.replace("px", "");
        this.chartElements.svg.attr("height", height);
        this.chartElements.svg.attr("width", width);
        this.chartElements.width = width - this.chartElements.margin.left - this.chartElements.margin.right;
        this.chartElements.height = height - this.chartElements.margin.top - this.chartElements.margin.bottom;
        this.chartElements.chartArea = this.chartElements.svg.append<SVGGElement>("g")
            .attr("class", "chart-area")
            .attr("transform", `translate(${this.chartElements.margin.left},${this.chartElements.margin.top})`);
        this.chartElements.xScale = d3.scaleLinear().range([0, this.chartElements.width]);
        this.chartElements.yScale = d3.scaleLinear().range([this.chartElements.height, 0]);
        this.chartElements.yScaleSlope = d3.scaleLinear().range([this.chartElements.height, 0]);
        this.chartElements.dragState = "none";
    }

    private createChartAxis() {
        let d3 = this.d3Service.getD3();
        this.chartElements.chartArea.append("g")
            .attr("class", "x-axis")
            .attr("transform", `translate(0,${this.chartElements.height})`)
            .call(d3.axisBottom(this.chartElements.xScale).ticks(5))
            .append("text")
            .attr("fill", "#000")
            .attr("text-anchor", "middle")
            .attr("transform", `translate(${this.chartElements.width / 2},30)`)
            .attr("dir", this.resources.direction)
            .text(this.resources.distanceInKm)
            .select(".domain")
            .remove();

        this.chartElements.chartArea.append("g")
            .attr("class", "y-axis")
            .call(d3.axisLeft(this.chartElements.yScale).ticks(5))
            .append("text")
            .attr("fill", "#000")
            .attr("transform", `translate(-30, ${this.chartElements.height / 2}) rotate(-90)`)
            .attr("text-anchor", "middle")
            .attr("dir", this.resources.direction)
            .text(this.resources.heightInMeters);

        if (this.isSlopeOn) {
            this.chartElements.chartArea.append("g")
                .attr("class", "y-axis-slope")
                .attr("transform", `translate(${this.chartElements.width}, 0)`)
                .call(d3.axisRight(this.chartElements.yScaleSlope).ticks(5))
                .append("text")
                .attr("fill", "#000")
                .attr("transform", `translate(10, ${this.chartElements.height / 2}) rotate(-90)`)
                .attr("text-anchor", "middle")
                .attr("dir", this.resources.direction)
                .text(this.resources.slope);
        }
    }

    private addChartPath() {
        this.chartElements.path = this.chartElements.chartArea.append<SVGPathElement>("path")
            .attr("class", "line")
            .attr("fill", "none")
            .attr("stroke-linejoin", "round")
            .attr("stroke-linecap", "round")
            .attr("stroke-width", 2);

        if (this.isSlopeOn) {
            this.chartElements.chartArea.append<SVGPathElement>("path")
                .attr("class", "slope-line")
                .attr("fill", "none")
                .attr("stroke-linejoin", "round")
                .attr("stroke-linecap", "round")
                .attr("stroke-width", 1)
                .attr("stroke", "black");
            this.chartElements.chartArea.append<SVGPathElement>("line")
                .attr("class", "slope-zero-axis")
                .attr("stroke-width", 1)
                .attr("stroke", "grey")
                .attr("stroke-dasharray", "10,5")
                .attr("x1", 0)
                .attr("x2", this.chartElements.width)
                .attr("y1", this.chartElements.height / 2)
                .attr("y2", this.chartElements.height / 2);
        }
    }

    private addChartDragGroup() {
        let dragGroup = this.chartElements.chartArea.append("g")
            .attr("class", "drag-group");

        this.chartElements.dragRect = dragGroup.append("rect")
            .attr("height", this.chartElements.height)
            .attr("width", 0)
            .attr("x", 0)
            .attr("fill", "gray")
            .attr("opacity", 0.4)
            .style("pointer-events", "none")
            .style("display", "none");
    }

    private addChartLocationGroup() {
        this.chartElements.locationGroup = this.chartElements.chartArea.append("g")
            .attr("class", "location-group")
            .style("display", "none");

        this.chartElements.locationGroup.append("circle")
            .attr("class", "location-circle")
            .attr("cx", 0)
            .attr("cy", 0)
            .attr("r", 5)
            .attr("fill", "none")
            .attr("stroke-width", 3)
            .attr("stroke", SelectedRouteService.RECORDING_ROUTE_COLOR);

        this.chartElements.locationGroup.append("line")
            .attr("class", "location-line")
            .attr("y1", 0)
            .attr("x1", 0)
            .attr("x2", 0)
            .attr("y2", this.chartElements.height)
            .attr("stroke", SelectedRouteService.RECORDING_ROUTE_COLOR)
            .attr("stroke-width", 2);
    }

    private addChartHoverGroup() {
        this.chartElements.hoverGroup = this.chartElements.chartArea.append("g")
            .attr("class", "hover-group")
            .style("display", "none");
        this.chartElements.hoverGroup.append("line")
            .attr("y1", 0)
            .attr("x1", 0)
            .attr("x2", 0)
            .attr("y2", this.chartElements.height)
            .attr("stroke", "black")
            .attr("stroke-width", 1);

        this.chartElements.hoverGroup.append("circle")
            .attr("class", "circle-point")
            .attr("cx", 0)
            .attr("cy", 0)
            .attr("r", 3)
            .attr("fill", "black");

        this.chartElements.hoverGroup.append("circle")
            .attr("class", "circle-point-aura")
            .attr("cx", 0)
            .attr("cy", 0)
            .attr("r", 5)
            .attr("fill", "none")
            .attr("stroke-width", 1);

        this.chartElements.hoverGroup.append("g")
            .append("rect")
            .attr("x", 0)
            .attr("y", 0)
            .attr("height", 70)
            .attr("width", RouteStatisticsComponent.HOVER_BOX_WIDTH)
            .attr("stroke", "black")
            .attr("fill", "white")
            .attr("fill-opacity", "0.9");
    }

    private addEventsSupport() {
        // responsive background
        this.chartElements.chartArea.append("rect")
            .attr("width", this.chartElements.width)
            .attr("height", this.chartElements.height)
            .style("fill", "none")
            .style("stroke", "none")
            .style("-moz-user-select", "none")
            .style("pointer-events", "all")
            .on("touchstart mousedown", () => {
                this.onMouseDown();
            })
            .on("mousemove touchmove", () => {
                this.onMouseMove();
            })
            .on("mouseup touchend", () => {
                this.onMouseUp();
            })
            .on("mouseout", () => {
                this.hideChartHover();
            });
    }

    private buildAllTextInHoverBox(point: IRouteStatisticsPoint) {
        this.chartElements.hoverGroup.selectAll("text").remove();
        this.createHoverBoxText(this.resources.distance, point.coordinate[0].toFixed(2), " " + this.resources.kmUnit, 20);
        this.createHoverBoxText(this.resources.height, point.coordinate[1].toFixed(0), " " + this.resources.meterUnit, 40, true);
        if (this.resources.direction === "rtl") {
            // the following is a hack due to bad svg presentation...
            this.createHoverBoxText(this.resources.slope, Math.abs(point.slope).toFixed(0) + "%", point.slope < 0 ? "-" : "", 60);
        } else {
            this.createHoverBoxText(this.resources.slope, point.slope.toFixed(0) + "%", "", 60);
        }

    }

    private createHoverBoxText(title: string, value: string, units: string, y: number, useBidi = false) {
        let x = 10;
        if (this.resources.direction === "rtl") {
            x = RouteStatisticsComponent.HOVER_BOX_WIDTH - x;
        }
        let text = this.chartElements.hoverGroup.select("g")
            .append("text")
            .attr("fill", "black")
            .attr("transform", `translate(${x}, ${y})`)
            .attr("text-anchor", "start")
            .attr("direction", this.resources.direction)
            .style("-webkit-user-select", "none")
            .style("-moz-user-select", "none")
            .style("-ms-user-select", "none")
            .style("pointer-events", "none");
        text.append("tspan")
            .text(`${title}: `);
        let valueSpan = text.append("tspan");
        if (useBidi) {
            valueSpan.attr("unicode-bidi", "embed").attr("direction", "ltr");
        }
        valueSpan.text(value);
        text.append("tspan")
            .text(units);
    }

    private setRouteColorToChart() {
        this.chartElements.path.attr("stroke", this.routeColor);
        this.chartElements.hoverGroup.select(".circle-point").attr("fill", this.routeColor);
        this.chartElements.hoverGroup.select(".circle-point-aura").attr("stroke", this.routeColor);
    }

    private setDataToChart(data: [number, number][]) {
        if (!this.isOpen) {
            return;
        }
        let d3 = this.d3Service.getD3();
        let duration = 1000;
        let chartTransition = this.chartElements.chartArea.transition();
        this.chartElements.xScale.domain([d3.min(data, d => d[0]), d3.max(data, d => d[0])]);
        this.chartElements.yScale.domain([d3.min(data, d => d[1]), d3.max(data, d => d[1])]);
        let line = d3.line()
            .curve(d3.curveCatmullRom)
            .x(d => this.chartElements.xScale(d[0]))
            .y(d => this.chartElements.yScale(d[1]));
        chartTransition.select(".line").duration(duration).attr("d", line(data));
        chartTransition.select(".x-axis")
            .duration(duration)
            .call(d3.axisBottom(this.chartElements.xScale).ticks(5) as any);
        chartTransition.select(".y-axis")
            .call(d3.axisLeft(this.chartElements.yScale).ticks(5) as any)
            .duration(duration);
        let slopeData = [];
        if (this.isSlopeOn && data.length > 0) {
            // smoothing the slope data for the chart
            slopeData = regressionLoess()
                .x(d => d.coordinate[0])
                .y(d => d.slope)
                .bandwidth(0.03)(this.statistics.points);
        }
        // making the doing be symetric around zero
        this.chartElements.yScaleSlope.domain([Math.min(d3.min(slopeData, d => d[1]), -d3.max(slopeData, d => d[1])),
        Math.max(d3.max(slopeData, d => d[1]), -d3.min(slopeData, d => d[1]))]);
        let slopeLine = d3.line()
            .curve(d3.curveCatmullRom)
            .x(d => this.chartElements.xScale(d[0]))
            .y(d => this.chartElements.yScaleSlope(d[1]));
        chartTransition.select(".slope-line").duration(duration).attr("d", slopeLine(slopeData));
        chartTransition.select(".y-axis-slope")
            .call(d3.axisRight(this.chartElements.yScaleSlope).ticks(5) as any)
            .duration(duration);
        let zeroAxisY = this.chartElements.yScaleSlope(0) || this.chartElements.height / 2;
        chartTransition.select(".slope-zero-axis").attr("y1", zeroAxisY).attr("y2", zeroAxisY);
    }

    public toggleKmMarker() {
        this.isKmMarkersOn = !this.isKmMarkersOn;
        this.updateKmMarkers();
    }

    public toggleSlope() {
        this.isSlopeOn = !this.isSlopeOn;
        this.redrawChart();
    }

    private updateKmMarkers() {
        this.kmMarkersSource = {
            type: "FeatureCollection",
            features: []
        };
        let route = this.getRouteForChart();
        if (route == null) {
            return;
        }
        if (this.isKmMarkersOn === false) {
            return;
        }
        if (route.segments.length <= 0) {
            return;
        }

        let points = this.getKmPoints(route);
        let features = [];
        for (let i = 0; i < points.length; i++) {
            features.push({
                type: "Feature",
                properties: { label: (i * this.getMarkerDistance()).toString() },
                geometry: {
                    type: "Point",
                    coordinates: [points[i].lng, points[i].lat]
                }
            });
        }
        this.kmMarkersSource = {
            type: "FeatureCollection",
            features
        };
    }

    private getKmPoints(routeData: RouteData): LatLngAlt[] {

        let length = 0;
        let markersDistance = this.getMarkerDistance() * 1000;
        let start = routeData.segments[0].routePoint;
        let results = [start];
        let previousPoint = start;
        for (let segment of routeData.segments) {
            for (let latlng of segment.latlngs) {
                let currentDistance = SpatialService.getDistanceInMeters(previousPoint, latlng);
                length += currentDistance;
                if (length < markersDistance) {
                    previousPoint = latlng;
                    continue;
                }
                let markersToAdd = -1;
                while (length > markersDistance) {
                    length -= markersDistance;
                    markersToAdd++;
                }
                let ratio = (currentDistance - length - markersDistance * markersToAdd) / currentDistance;
                results.push(SpatialService.getLatlngInterpolatedValue(previousPoint, latlng, ratio));
                for (let i = 1; i <= markersToAdd; i++) {
                    let currentRatio = (i * markersDistance) / currentDistance + ratio;
                    results.push(SpatialService.getLatlngInterpolatedValue(previousPoint, latlng, currentRatio));
                }
                previousPoint = latlng;
            }
        }
        return results;
    }

    private getMarkerDistance(): number {
        if (this.zoom < 7) {
            return 100;
        }
        if (this.zoom < 9) {
            return 50;
        }
        if (this.zoom < 11) {
            return 10;
        }
        if (this.zoom < 13) {
            return 5;
        }
        return 1;
    }

    public toggleExpand() {
        this.isExpanded = !this.isExpanded;
        this.redrawChart();
    }

    private updateSubRouteSelectionOnChart() {
        if (this.subRouteRange == null) {
            this.clearSubRouteSelection();
            return;
        }
        let xStart = this.chartElements.xScale(Math.min(this.subRouteRange.xStart, this.subRouteRange.xEnd));
        let xEnd = this.chartElements.xScale(Math.max(this.subRouteRange.xStart, this.subRouteRange.xEnd));
        this.chartElements.dragRect.style("display", null)
            .attr("width", xEnd - xStart)
            .attr("x", xStart);

        let start = this.routeStatisticsService.interpolateStatistics(this.statistics, this.chartElements.xScale.invert(xStart));
        let end = this.routeStatisticsService.interpolateStatistics(this.statistics, this.chartElements.xScale.invert(xEnd));
        let statistics = this.routeStatisticsService.getStatisticsByRange(this.getRouteForChart(), start, end);
        this.setViewStatisticsValues(statistics);
    }

    public clearSubRouteSelection() {
        this.chartElements.dragRect.style("display", "none");
        this.subRouteRange = null;
        this.setViewStatisticsValues(this.statistics);
    }

    private onSelectedRouteHover = (latlng: LatLngAlt) => {
        if (!this.isOpen) {
            return;
        }
        let point = this.getPointFromLatLng(latlng);
        this.showChartHover(point);
    }

    private onGeolocationChanged(position: Position) {
        this.currentSpeed = (position == null) ? null : position.coords.speed * 3.6;
        const currentSpeedTimeout = "currentSpeedTimeout";
        this.cancelableTimeoutService.clearTimeoutByGroup(currentSpeedTimeout);
        this.cancelableTimeoutService.setTimeoutByGroup(() => {
            // if there are no location updates reset speed.
            this.currentSpeed = null;
        }, 5000, currentSpeedTimeout);
        this.onRouteDataChanged();
    }

    private refreshLocationGroup() {
        let point = this.getPointFromLatLng(this.geoLocationService.currentLocation);
        if (!point) {
            this.hideLocationGroup();
            return;
        }
        let chartXCoordinate = this.chartElements.xScale(point.coordinate[0]);
        let chartYCoordinate = this.chartElements.yScale(point.coordinate[1]);
        if (isNaN(chartXCoordinate) || isNaN(chartXCoordinate)) {
            // this is the case of no data on chart
            this.hideLocationGroup();
            return;
        }
        this.chartElements.locationGroup.style("display", null);
        this.chartElements.locationGroup.attr("transform", `translate(${chartXCoordinate}, 0)`);
        this.chartElements.locationGroup.selectAll("circle").attr("cy", chartYCoordinate);
    }

    private hideLocationGroup() {
        if (this.chartElements.locationGroup) {
            this.chartElements.locationGroup.style("display", "none");
        }
    }

    private getPointFromLatLng(latlng: LatLngAlt): IRouteStatisticsPoint {
        if (latlng == null) {
            return null;
        }
        if (this.statistics == null) {
            return null;
        }
        let x = this.routeStatisticsService.findDistanceForLatLngInKM(this.statistics, latlng);
        if (x <= 0) {
            return null;
        }
        return this.routeStatisticsService.interpolateStatistics(this.statistics, x);
    }

    private updateStatistics() {
        let route = this.getRouteForChart();
        if (!route) {
            this.statistics = null;
            this.setViewStatisticsValues(null);
            return;
        }
        let closestRouteToGps = this.selectedRouteService.getClosestRouteToGPS(this.geoLocationService.currentLocation);
        let routeIsRecording = this.selectedRouteService.getRecordingRoute() != null &&
            this.selectedRouteService.getRecordingRoute().id === route.id;
        this.statistics = this.routeStatisticsService.getStatistics(
            route,
            closestRouteToGps,
            this.geoLocationService.currentLocation,
            routeIsRecording);
        this.routeColor = closestRouteToGps ? closestRouteToGps.color : route.color;
        this.updateIsFollowing();
        this.setViewStatisticsValues(this.statistics);
    }

    private getRouteForChart() {
        let selectedRoute = this.selectedRouteService.getSelectedRoute();
        let closestRouteToGps = this.selectedRouteService.getClosestRouteToGPS(this.geoLocationService.currentLocation);
        return selectedRoute || closestRouteToGps;
    }

    private getDataFromStatistics(): [number, number][] {
        let data = [];
        if (this.statistics) {
            data = this.statistics.points.map(p => p.coordinate);
        }
        return data;
    }

    private updateIsFollowing() {
        let newIsFollowing = this.statistics.remainingDistance != null;
        if (this.isFollowing === newIsFollowing) {
            return;
        }
        this.isFollowing = newIsFollowing;
        if (this.ngRedux.getState().configuration.isGotLostWarnings && this.isFollowing === false) {
            // is following stopped - playing sound and vibration
            if (navigator.vibrate) {
                navigator.vibrate([200, 100, 200]);
            }
            this.audioPlayer.play();
        }
    }
}